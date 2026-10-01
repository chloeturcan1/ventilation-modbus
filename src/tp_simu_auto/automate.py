"""Modèle de l'installation de ventilation et de sa logique automate.

Le modèle ne connaît rien de Modbus : il est piloté par server.py, qui lui
transmet les commandes (mode, forçages) lues dans les coils/holding registers et
recopie températures et états des ventilateurs dans les registres. Seules les
plages de réglage acceptées (SETPOINT_MIN...) sont lues dans modbus_map, qui
les partage avec l'IHM.

Physique simplifiée, en temps accéléré pour la démonstration :

- extérieur : cycle jour/nuit sinusoïdal de période day_period_s, autour de
  24 °C en été et de 5 °C en hiver ;
- intérieur : apports de chaleur constants (soleil, occupants), plus en hiver la
  boucle thermohydraulique qui chauffe le bâtiment ; échanges avec l'extérieur
  à travers les parois, et chaque ventilateur en marche ajoute un échange d'air
  qui rapproche l'intérieur de la température extérieure.

Logique (avec hystérésis pour éviter les battements autour des seuils ; les
valeurs citées sont les réglages par défaut, modifiables via Settings) :

- V1, V2, V3 (extraction de l'air intérieur) : marche à partir de
  23 / 24 / 25 °C intérieur en été, 26 / 27 / 28 °C en hiver (on profite de la
  chaleur de la boucle),
  arrêt quand la température repasse sous seuil - hystérésis (0,5 °C) ;
- V4 (monté à l'envers, insufflation d'air extérieur) : marche seulement si
  T_int > T_ext, c'est-à-dire si l'air extérieur est plus frais,
  et en hiver seulement si de plus T_int > 28 °C ;
  arrêt quand T_int < T_ext - hystérésis (ou, en hiver, T_int < 28 - hystérésis).

Conduite et sécurités, appliquées par ordre de priorité décroissante :

1. arrêt d'urgence : tous les ventilateurs s'arrêtent, même en manuel ; après
   relâchement du bouton, rien ne redémarre avant un acquittement (réarmement) ;
2. défaut de rotation : un ventilateur commandé mais sans retour de marche
   pendant fan_feedback_delay_s est verrouillé à l'arrêt jusqu'à acquittement ;
3. mode manuel (marche forcée / arrêt forcé), réglable ventilateur par
   ventilateur ;
4. logique automatique ci-dessus, en mode dégradé si un capteur est hors de sa
   plage de mesure : sans T_int, seul V1 tourne (renouvellement d'air minimal) ;
   sans T_ext, V4 s'arrête (impossible de comparer intérieur et extérieur).

Chaque alarme est mémorisée dès que sa cause apparaît ; l'acquittement efface
les alarmes mémorisées dont la cause a disparu.
"""

import math
from dataclasses import dataclass, field
from enum import Enum, auto

from tp_simu_auto import modbus_map as mm


def _with_hysteresis(on: bool, value: float, threshold: float, hysteresis: float) -> bool:
    """Marche dès que value >= threshold, arrêt quand value < threshold - hysteresis."""
    if on:
        return value >= threshold - hysteresis
    return value >= threshold


class FanMode(Enum):
    AUTO = auto()
    MANUAL_ON = auto()
    MANUAL_OFF = auto()


class Alarm(Enum):
    EMERGENCY_STOP = auto()
    T_INT_HIGH = auto()
    SENSOR_T_INT = auto()
    SENSOR_T_EXT = auto()
    FAN_1 = auto()
    FAN_2 = auto()
    FAN_3 = auto()
    FAN_4 = auto()


FAN_ALARMS = (Alarm.FAN_1, Alarm.FAN_2, Alarm.FAN_3, Alarm.FAN_4)


@dataclass(frozen=True)
class Settings:
    """Réglages de la logique, modifiables en fonctionnement depuis l'IHM."""

    summer_fan_thresholds: tuple[float, float, float] = (23.0, 24.0, 25.0)
    winter_fan_thresholds: tuple[float, float, float] = (26.0, 27.0, 28.0)
    winter_intake_threshold: float = 28.0  # V4 en hiver : T_int doit dépasser ce seuil
    hysteresis: float = 0.5
    t_int_high_alarm: float = 35.0

    def errors(self) -> list[str]:
        """Raisons de refuser ces réglages (liste vide si ils sont cohérents).

        Mêmes règles que checkSettings() dans ihm/server.js.
        """
        errors = []
        setpoints = {
            "seuils ete": self.summer_fan_thresholds,
            "seuils hiver": self.winter_fan_thresholds,
            "seuil insufflation hiver": (self.winter_intake_threshold,),
            "seuil alarme haute": (self.t_int_high_alarm,),
        }
        for name, values in setpoints.items():
            if any(not mm.SETPOINT_MIN <= v <= mm.SETPOINT_MAX for v in values):
                errors.append(f"{name} hors de {mm.SETPOINT_MIN}..{mm.SETPOINT_MAX} C")
        for name in ("seuils ete", "seuils hiver"):
            v1, v2, v3 = setpoints[name]
            if not v1 <= v2 <= v3:
                errors.append(f"{name} non croissants (V1 <= V2 <= V3)")
        if not mm.HYSTERESIS_MIN <= self.hysteresis <= mm.HYSTERESIS_MAX:
            errors.append(f"hysteresis hors de {mm.HYSTERESIS_MIN}..{mm.HYSTERESIS_MAX} C")
        return errors


@dataclass
class Automate:
    """Ventilation à 4 ventilateurs, capteurs de température intérieur et extérieur."""

    # Commandes (venant de l'IHM via Modbus)
    summer_mode: bool = True
    t_int_forced: float | None = None  # None = valeur simulée
    t_ext_forced: float | None = None
    fan_modes: list[FanMode] = field(default_factory=lambda: [FanMode.AUTO] * 4)
    emergency_stop: bool = False  # bouton d'arrêt d'urgence enfoncé
    fan_faults: list[bool] = field(default_factory=lambda: [False] * 4)  # pannes simulées

    # Ventilateurs V1..V4 : demande de la logique automatique, commande réellement
    # envoyée (après modes et sécurités) et retour de marche (rotation constatée)
    auto_fans: list[bool] = field(default_factory=lambda: [False] * 4)
    fan_commands: list[bool] = field(default_factory=lambda: [False] * 4)
    fans: list[bool] = field(default_factory=lambda: [False] * 4)

    # Alarmes : cause présente / mémorisée en attente d'acquittement
    alarms_active: set[Alarm] = field(default_factory=set)
    alarms_latched: set[Alarm] = field(default_factory=set)

    # Logique et seuil d'alarme haute
    settings: Settings = field(default_factory=Settings)

    # Sécurités
    sensor_min: float = -40.0  # plage de mesure des capteurs : hors plage = défaut capteur
    sensor_max: float = 80.0
    fan_feedback_delay_s: float = 2.0  # délai toléré entre commande et retour de marche
    _stalled_s: list[float] = field(default_factory=lambda: [0.0] * 4, repr=False)
    _ack_requested: bool = field(default=False, repr=False)

    # Mesures (°C)
    t_int: float = 22.0
    t_ext: float = 24.0

    # Physique extérieure : t_ext = moyenne + amplitude * sin(2 pi t / période)
    summer_t_ext_mean: float = 24.0
    summer_t_ext_amplitude: float = 6.0
    winter_t_ext_mean: float = 5.0
    winter_t_ext_amplitude: float = 5.0
    day_period_s: float = 600.0  # une « journée » simulée dure 10 minutes
    clock_s: float = 0.0

    # Physique intérieure (en °C/s et 1/s)
    heat_gain: float = 0.05  # apports internes
    heating_loop_gain: float = 0.55  # boucle thermohydraulique, active en hiver
    wall_exchange: float = 0.005  # échange par les parois
    fan_exchange: float = 0.02  # échange d'air apporté par chaque ventilateur

    def step(self, dt: float) -> None:
        """Avance la simulation de dt secondes, puis recalcule alarmes et ventilateurs."""
        self.clock_s += dt
        self._update_temperatures(dt)
        t_int_ok = self.sensor_min <= self.t_int <= self.sensor_max
        t_ext_ok = self.sensor_min <= self.t_ext <= self.sensor_max
        self._update_alarms(dt, t_int_ok, t_ext_ok)
        if self._ack_requested:
            # Traité après le calcul des alarmes : un défaut qui disparaît dans ce
            # même cycle est bien acquitté.
            self.alarms_latched &= self.alarms_active
            self._ack_requested = False
        self._update_auto_fans(t_int_ok, t_ext_ok)
        self._update_fan_commands()

    def acknowledge(self) -> None:
        """Demande d'acquittement : au prochain step(), efface les alarmes
        mémorisées dont la cause a disparu."""
        self._ack_requested = True

    def _update_temperatures(self, dt: float) -> None:
        if self.t_ext_forced is not None:
            self.t_ext = self.t_ext_forced
        else:
            if self.summer_mode:
                mean, amplitude = self.summer_t_ext_mean, self.summer_t_ext_amplitude
            else:
                mean, amplitude = self.winter_t_ext_mean, self.winter_t_ext_amplitude
            phase = 2 * math.pi * self.clock_s / self.day_period_s
            self.t_ext = mean + amplitude * math.sin(phase)

        if self.t_int_forced is not None:
            self.t_int = self.t_int_forced
        else:
            gain = self.heat_gain + (0.0 if self.summer_mode else self.heating_loop_gain)
            exchange = self.wall_exchange + self.fan_exchange * sum(self.fans)
            self.t_int += (gain - exchange * (self.t_int - self.t_ext)) * dt

    def _update_alarms(self, dt: float, t_int_ok: bool, t_ext_ok: bool) -> None:
        # Défaut de rotation : commandé au cycle précédent mais toujours à l'arrêt.
        for i, (command, running) in enumerate(zip(self.fan_commands, self.fans)):
            self._stalled_s[i] = self._stalled_s[i] + dt if command and not running else 0.0

        t_int_high = _with_hysteresis(
            Alarm.T_INT_HIGH in self.alarms_active,
            self.t_int,
            self.settings.t_int_high_alarm,
            self.settings.hysteresis,
        )
        causes = {
            Alarm.EMERGENCY_STOP: self.emergency_stop,
            # Une mesure hors plage n'a pas de sens : pas d'alarme haute sur capteur HS.
            Alarm.T_INT_HIGH: t_int_ok and t_int_high,
            Alarm.SENSOR_T_INT: not t_int_ok,
            Alarm.SENSOR_T_EXT: not t_ext_ok,
        }
        for alarm, stalled in zip(FAN_ALARMS, self._stalled_s):
            causes[alarm] = stalled >= self.fan_feedback_delay_s
        self.alarms_active = {alarm for alarm, present in causes.items() if present}
        self.alarms_latched |= self.alarms_active

    def _update_auto_fans(self, t_int_ok: bool, t_ext_ok: bool) -> None:
        if not t_int_ok:
            # Mode dégradé : sans mesure intérieure, V1 assure un renouvellement d'air minimal.
            self.auto_fans = [True, False, False, False]
            return

        settings = self.settings
        thresholds = (
            settings.summer_fan_thresholds if self.summer_mode else settings.winter_fan_thresholds
        )
        new = [
            _with_hysteresis(on, self.t_int, threshold, settings.hysteresis)
            for on, threshold in zip(self.auto_fans[:3], thresholds)
        ]

        # V4 : marche seulement si T_int > T_ext (strict : à égalité, faire entrer l'air
        # extérieur ne sert à rien) ; en hiver, il faut en plus T_int > seuil
        # d'insufflation, pour ne pas refroidir le bâtiment chauffé (strict aussi).
        # Sans mesure extérieure, la comparaison est impossible : V4 reste à l'arrêt.
        delta = self.t_int - self.t_ext
        if not t_ext_ok:
            v4 = False
        elif self.auto_fans[3]:
            v4 = delta >= -settings.hysteresis and (
                self.summer_mode
                or self.t_int >= settings.winter_intake_threshold - settings.hysteresis
            )
        else:
            v4 = delta > 0 and (
                self.summer_mode or self.t_int > settings.winter_intake_threshold
            )
        new.append(v4)
        self.auto_fans = new

    def _update_fan_commands(self) -> None:
        emergency = Alarm.EMERGENCY_STOP in self.alarms_latched
        commands = []
        for mode, auto_on, alarm in zip(self.fan_modes, self.auto_fans, FAN_ALARMS):
            if emergency or alarm in self.alarms_latched:
                commands.append(False)
            elif mode is FanMode.MANUAL_ON:
                commands.append(True)
            elif mode is FanMode.MANUAL_OFF:
                commands.append(False)
            else:
                commands.append(auto_on)
        self.fan_commands = commands
        # Retour de marche : un ventilateur en panne ne tourne pas, même commandé.
        self.fans = [on and not fault for on, fault in zip(commands, self.fan_faults)]
