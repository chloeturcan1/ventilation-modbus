// Sert les pages de l'IHM (public/).
const fs = global.get("fs");
const path = global.get("path");
const FILES = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/alertes": ["alertes.html", "text/html; charset=utf-8"],
    "/common.css": ["common.css", "text/css; charset=utf-8"],
};
// Les pages utilisent des adresses relatives : la supervision doit être
// ouverte avec la barre finale (/ihm/ et non /ihm).
const url = msg.req.originalUrl.split("?")[0];
if (msg.req.route.path === "/" && !url.endsWith("/")) {
    msg.statusCode = 301;
    msg.headers = { Location: url + "/" };
    msg.payload = "";
    return msg;
}
const [file, type] = FILES[msg.req.route.path];
msg.statusCode = 200;
msg.headers = { "Content-Type": type, "Cache-Control": "no-cache" };
msg.payload = fs.readFileSync(path.join(global.get("publicDir"), file), "utf8");
return msg;
