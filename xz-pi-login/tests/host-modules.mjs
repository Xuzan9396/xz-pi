// Standalone node:test must use the same SDK as Pi, without installing runtime
// peer copies. The production extension loader supplies these bindings itself.
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { hostEntry } from "./host-path.mjs";

{
  const parentURL = pathToFileURL(hostEntry).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!context.conditions.includes("require") && (specifier === "@earendil-works/pi-ai" || specifier.startsWith("@earendil-works/pi-ai/"))) return nextResolve(specifier, { ...context, parentURL });

      return nextResolve(specifier, context);
    },
  });
}
