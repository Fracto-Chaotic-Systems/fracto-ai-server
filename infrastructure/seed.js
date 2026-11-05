import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const references = ["ownership", "terrain", "ai-deployment", "game-authority"];
export const seed_infrastructure = (store) => {
  for (const name of references) {
    const text = fs.readFileSync(
      path.join(import.meta.dirname, `${name}.md`),
      "utf8",
    );
    const source = `builtin-${name}`;
    const revision = `v${createHash("sha256").update(text).digest("hex")}`;
    const current = store.current(source);
    if (current?.retired) continue;
    if (current && !/^v[a-f0-9]{64}$/.test(current.current_revision)) continue;
    store.put(source, revision, text, current?.current_revision ?? null);
  }
};
