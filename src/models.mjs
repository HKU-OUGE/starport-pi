import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { privateDir } from "./config.mjs";
const catalogs = new Map();
export function modelChoices(root) {
  if (!catalogs.has(root))
    catalogs.set(
      root,
      (async () => {
        const runtime = await ModelRuntime.create({
          authPath: path.join(
            privateDir(path.join(root, "catalog")),
            "auth.json",
          ),
          modelsPath: null,
          allowModelNetwork: false,
          refreshOnCreate: false,
        });
        return runtime
          .getModels("anthropic")
          .map(({ id, name }) => ({ id, name }))
          .sort((a, b) =>
            b.id.localeCompare(a.id, undefined, { numeric: true }),
          );
      })(),
    );
  return catalogs.get(root);
}
