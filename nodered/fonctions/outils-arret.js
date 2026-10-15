// Au redéploiement : ferme les flux temps réel des pages ouvertes, qui se
// reconnectent d'elles-mêmes au nouveau flux.
const ihm = global.get("ihm");
if (ihm) for (const res of ihm.sseClients) res.end();
