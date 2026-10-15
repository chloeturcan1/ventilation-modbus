// GET events : flux temps réel (Server-Sent Events). La connexion reste
// ouverte, et « Outils partagés » y écrit l'état à chaque lecture de l'automate.
const ihm = global.get("ihm");
const res = msg.res._res;
res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
});
res.write(`data: ${JSON.stringify({ ...ihm.state, journal: ihm.journal })}\n\n`);
ihm.sseClients.add(res);
msg.req.on("close", () => ihm.sseClients.delete(res));
node.status({ text: `${ihm.sseClients.size} page(s) ouverte(s)` });
return null;
