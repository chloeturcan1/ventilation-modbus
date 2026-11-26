# Table d'échange Modbus — automate de ventilation

Copie de la section « Table d'échange Modbus » du [README](README.md#table-déchange-modbus),
pour l'avoir sous la main. La même carte mémoire figure aussi, au format
`CO / DI / HR / IR`, en tête de [`server.py`](server.py).

Automate : unit id **1**, port **502**. Toutes les adresses sont définies à un
seul endroit, [`modbus_map.py`](src/ventilation_modbus/modbus_map.py), que l'automate,
le client et l'IHM utilisent tous.

| Type | Adresse | Accès | Signification |
|---|---|---|---|
| Coil | 0 | lecture/écriture | Mode : 1 = été, 0 = hiver |
| Coil | 1 | lecture/écriture | Forçage de T_int actif |
| Coil | 2 | lecture/écriture | Forçage de T_ext actif |
| Coil | 3 | lecture/écriture | Arrêt d'urgence enfoncé |
| Coil | 4 | lecture/écriture | Acquittement : écrire 1, l'automate le remet à 0 |
| Coil | 5 à 8 | lecture/écriture | Panne moteur simulée de V1 à V4 (tests) |
| Coil | 9 | lecture/écriture | Retour aux réglages par défaut : écrire 1, l'automate le remet à 0 |
| Holding register | 0 | lecture/écriture | Valeur forcée de T_int |
| Holding register | 1 | lecture/écriture | Valeur forcée de T_ext |
| Holding register | 2 à 5 | lecture/écriture | Mode de V1 à V4 : 0 = auto, 1 = marche, 2 = arrêt |
| Holding register | 6 à 8 | lecture/écriture | Seuils de démarrage V1 à V3 en été |
| Holding register | 9 à 11 | lecture/écriture | Seuils de démarrage V1 à V3 en hiver |
| Holding register | 12 | lecture/écriture | Seuil d'insufflation V4 en hiver |
| Holding register | 13 | lecture/écriture | Hystérésis |
| Holding register | 14 | lecture/écriture | Seuil de l'alarme température haute |
| Discrete input | 0 à 3 | lecture seule | Retour de marche de V1 à V4 |
| Input register | 0 | lecture seule | T_int |
| Input register | 1 | lecture seule | T_ext |
| Input register | 2 | lecture seule | Mot d'alarmes actives |
| Input register | 3 | lecture seule | Mot d'alarmes mémorisées (à acquitter) |

Les températures, seuils et hystérésis sont transmis en **dixièmes de degré**,
en entier signé 16 bits pour accepter les valeurs négatives (23,4 °C → 234).
Les réglages (registres 6 à 14) s'écrivent **en une seule requête** (FC16),
puisque l'automate vérifie la cohérence de l'ensemble.

Dans les **mots d'alarmes**, chaque bit correspond à une alarme : bit 0 arrêt
d'urgence, bit 1 température haute, bit 2 défaut capteur T_int, bit 3 défaut
capteur T_ext, bits 4 à 7 défaut rotation V1 à V4. Par exemple, un mot qui vaut
`0x21` signale l'arrêt d'urgence et un défaut de rotation sur V2.
