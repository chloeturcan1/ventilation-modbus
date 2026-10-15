// Chaque seconde : sans lecture réussie depuis 2 s, l'automate est déclaré
// injoignable, et les pages affichent la perte de liaison.
const ihm = global.get("ihm");
if (Date.now() - ihm.lastRead > 2000) {
    if (ihm.state.connected) node.warn("Automate injoignable, nouvelle tentative...");
    ihm.state = { connected: false, error: "automate injoignable" };
    ihm.broadcast();
    node.status({ fill: "red", shape: "ring", text: "automate injoignable" });
} else {
    node.status({ fill: "green", shape: "dot", text: "liaison OK" });
}
return null;
