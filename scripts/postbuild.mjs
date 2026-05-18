import { cp, access } from "node:fs/promises";
import { resolve } from "node:path";

const dir = resolve("build/client");
const fallback = resolve(dir, "__spa-fallback.html");
const root = resolve(dir, "index.html");
const notFound = resolve(dir, "404.html");

const source = await access(fallback).then(
  () => fallback,
  () => root,
);

await cp(source, notFound);
console.log(`postbuild: copied ${source} -> ${notFound}`);
