"""Modèle de l'installation de ventilation et de sa logique automate.

Le modèle ne connaît rien de Modbus : il est piloté par server.py, qui lui
transmet les commandes (mode, forçages) lues dans les coils/holding registers et
recopie températures et états des ventilateurs dans les registres.

Physique simplifiée, en temps accéléré pour la démonstration :

- extérieur : cycle jour/nuit sinusoïdal de période day_period_s, autour de
  24 °C en été et de 5 °C en hiver ;
- intérieur : apports de chaleur constants (soleil, occupants), plus en hiver la
  boucle thermohydraulique qui chauffe le bâtiment ; échanges avec l'extérieur
  à travers les parois, et chaque ventilateur en marche ajoute un échange d'air
  qui rapproche l'intérieur de la température extérieure.

Logique (avec hystérésis pour éviter les battements autour des seuils) :

- V1, V2, V3 (soufflage) : marche à partir de 23 / 24 / 25 °C intérieur en été,
  26 / 27 / 28 °C en hiver (on profite de la chaleur de la boucle),
  arrêt quand la température repasse sous seuil - hystérésis ;
- V4 (monté à l'envers, extraction) : marche seulement si T_int > T_ext,
  et en hiver seulement si de plus T_int > 28 °C ;
  arrêt quand T_int < T_ext - hystérésis (ou, en hiver, T_int < 28 - hystérésis).
"""

import math
from dataclasses import dataclass, field


def _with_hysteresis(on: bool, value: float, threshold: float, hysteresis: float) -> bool:
    """Marche dès que value >= threshold, arrêt quand value < threshold - hysteresis."""
    if on:
        return value >= threshold - hysteresis
    return value >= threshold


@dataclass
class Automate:
    """Ventilation à 4 ventilateurs, capteurs de température intérieur et extérieur."""

    # Commandes (venant de l'IHM via Modbus)
    summer_mode: bool = True
    t_int_forced: float | None = None  # None = valeur simulée
    t_ext_forced: float | None = None

    # Sorties : état des ventilateurs V1..V4
    fans: list[bool] = field(default_factory=lambda: [False] * 4)

    # Logique
    summer_fan_thresholds: tuple[float, float, float] = (23.0, 24.0, 25.0)
    winter_fan_thresholds: tuple[float, float, float] = (26.0, 27.0, 28.0)
    winter_extract_threshold: float = 28.0  # V4 en hiver : T_int doit dépasser ce seuil
    hysteresis: float = 0.5

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
        """Avance la simulation de dt secondes, puis recalcule les ventilateurs."""
        self.clock_s += dt
        self._update_temperatures(dt)
        self._update_fans()

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

    def _update_fans(self) -> None:
        thresholds = (
            self.summer_fan_thresholds if self.summer_mode else self.winter_fan_thresholds
        )
        new = [
            _with_hysteresis(on, self.t_int, threshold, self.hysteresis)
            for on, threshold in zip(self.fans[:3], thresholds)
        ]

        # V4 : marche seulement si T_int > T_ext (strict : à égalité, extraire ne sert
        # à rien) ; en hiver, il faut en plus T_int > 28 °C (strict aussi).
        delta = self.t_int - self.t_ext
        if self.fans[3]:
            v4 = delta >= -self.hysteresis and (
                self.summer_mode
                or self.t_int >= self.winter_extract_threshold - self.hysteresis
            )
        else:
            v4 = delta > 0 and (
                self.summer_mode or self.t_int > self.winter_extract_threshold
            )
        new.append(v4)
        self.fans = new
