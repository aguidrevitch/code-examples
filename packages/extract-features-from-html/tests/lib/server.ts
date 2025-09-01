import express from "express";

export const app = express();
// lets serve static files from the public directory
const __dirname = new URL(".", import.meta.url).pathname;

app.use(express.static(__dirname + "../static-files/"));