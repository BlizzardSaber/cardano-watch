import { cp, mkdir, rm } from "node:fs/promises";

const source = new URL("../dist/", import.meta.url);
const target = new URL("../ios/CardanoWatch/Web/", import.meta.url);
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
