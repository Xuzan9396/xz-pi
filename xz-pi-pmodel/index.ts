import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { PModelSelectorComponent, type SelectorAction } from "./src/model-selector.js";
import { reconcileProjectConfiguration } from "./src/configuration.js";
import {
  clearProjectOverride,
  getPreferencePaths,
  readPreferenceLayers,
  resolvePreferences,
  writePreferenceOverride,
  type PreferenceOverrideTarget,
} from "./src/preferences.js";
import {
  clearProjectModelDefault,
  getPiSettingsPaths,
  readPiSettingsLayers,
  resolveModelDefaultState,
  toggleModelDefault,
} from "./src/pi-settings.js";
import { cleanupGlobalScopedModels, resolveGlobalScopedModelsState, toggleGlobalScopedModel } from "./src/scoped-models.js";

async function applyAction(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  action: SelectorAction,
  paths: ReturnType<typeof getPiSettingsPaths>,
): Promise<boolean> {
  if (action.type === "cancel") return false;

  if ("model" in action) {
    const catalog = ctx.modelRegistry.getAll();
    const selected = action.model;
    const fresh = catalog.find((model) => model.provider === selected.provider && model.id === selected.id);
    if (!fresh && !ctx.modelRegistry.getError() && catalog.length > 0) {
      throw new Error("This model was removed while the picker was open. Reopen /pmodel.");
    }
    if (fresh) action = { ...action, model: fresh };

  }

  if (action.type === "select-model") {
    const changed = await pi.setModel(action.model);
    if (!changed) {
      ctx.ui.notify(`No configured authentication for ${action.model.provider}/${action.model.id}`, "error");
      return false;
    }
    return false;
  }

  const projectTrusted = ctx.isProjectTrusted();
  const writeOptions = { projectTrusted };
  if (action.type === "clear-project-model-default") {
    clearProjectModelDefault(paths, writeOptions);
    ctx.ui.notify("Project model default cleared; global default is inherited", "info");
  }

  return true;
}

export function createPModelExtension() {
  return function pmodelExtension(pi: ExtensionAPI): void {
    let scopeWrites = Promise.resolve();
    let pendingDefaultsReload = false;
    const serializeScopeWrite = <T>(run: () => Promise<T>): Promise<T> => {
      const result = scopeWrites.then(run);
      scopeWrites = result.then(() => undefined, () => undefined);
      return result;
    };
    const cleanupGlobalScope = async (
      ctx: ExtensionContext,
      catalog: readonly Model<any>[],
      catalogError?: string,
    ): Promise<void> => {
      const result = await cleanupGlobalScopedModels(
        getPiSettingsPaths(ctx.cwd),
        catalog,
        catalogError ? { catalogError } : {},
      );
      if (!ctx.hasUI) return;
      if (result.removedPatterns.length > 0) {
        ctx.ui.notify(
          `Cleaned global enabledModels: ${result.removedPatterns.join(", ")}. Restart Pi to refresh the active scope.`,
          "info",
        );
      } else if (result.skippedReason) {
        ctx.ui.notify(`Automatic global scope cleanup skipped: ${result.skippedReason}`, "warning");
      }
    };
    const reportCleanupFailure = (ctx: ExtensionContext, error: unknown): void => {
      const message = `Automatic model configuration cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else console.warn(message);
    };

    const maintainConfiguration = async (ctx: ExtensionContext, refreshCatalog: boolean): Promise<void> => {
      let refreshError: string | undefined;
      if (refreshCatalog) {
        try {
          const refresh = await ctx.modelRegistry.refresh({ allowNetwork: false, signal: AbortSignal.timeout(5_000) });
          if (refresh.aborted || refresh.errors.size > 0) refreshError = "Model catalog refresh did not complete reliably.";
        } catch {
          refreshError = "Model catalog refresh failed; configured references were retained.";
        }
      }
      const catalog = ctx.modelRegistry.getAll();
      const catalogError = refreshError ?? ctx.modelRegistry.getError();
      // Global scope maintenance must not be blocked by malformed project data.
      try {
        await cleanupGlobalScope(ctx, catalog, catalogError);
      } catch (error) {
        reportCleanupFailure(ctx, error);
      }
      const result = (() => {
        try {
          return reconcileProjectConfiguration(getPreferencePaths(ctx.cwd), getPiSettingsPaths(ctx.cwd), catalog,
            { projectTrusted: ctx.isProjectTrusted(), ...(catalogError ? { catalogError } : {}) });
        } catch (error) {
          if (error instanceof Error && "settingsChanged" in error && error.settingsChanged === true) pendingDefaultsReload = true;
          throw error;
        }
      })();
      if (result.ordering.cleared.length > 0 && ctx.hasUI) {
        ctx.ui.notify("Provider/model ordering is global; legacy project ordering was migrated or removed.", "info");
      }
      if (result.visibility.restoredProviders.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`Project visibility restored to global: ${result.visibility.restoredProviders.join(", ")}`, "info");
      }
      if (result.defaults.modelDefaultCleared || result.thinkingMigration.changed) {
        pendingDefaultsReload = true;
        if (ctx.hasUI) ctx.ui.notify(
          "Project defaults repaired or legacy thinking fields removed. Pi manages thinking; /reload or restart Pi to sync official defaults.",
          "info",
        );
      }
    };

    pi.on("session_start", async (_event, ctx) => {
      try {
        await serializeScopeWrite(() => maintainConfiguration(ctx, false));
      } catch (error) {
        reportCleanupFailure(ctx, error);
      }
    });

    pi.registerCommand("pmodel", {
      description: "Select and organize models by provider without replacing /model",
      handler: async (args, ctx) => {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/pmodel requires TUI mode", "error");
          return;
        }

        try {
          await serializeScopeWrite(() => maintainConfiguration(ctx, true));
        } catch (error) {
          reportCleanupFailure(ctx, error);
        }

        const allModels = ctx.modelRegistry.getAvailable();
        if (allModels.length === 0) {
          ctx.ui.notify("No models are available. Use /login to configure a provider.", "warning");
          return;
        }

        const preferencePaths = getPreferencePaths(ctx.cwd);
        const piSettingsPaths = getPiSettingsPaths(ctx.cwd);
        const readResolvedPreferences = () => {
          const layers = readPreferenceLayers(preferencePaths, { projectTrusted: ctx.isProjectTrusted() });
          return resolvePreferences(layers.global, layers.project);
        };
        const projectTrusted = ctx.isProjectTrusted();
        const piSettings = readPiSettingsLayers(piSettingsPaths, { projectTrusted });
        const sessionScopedModels = ctx.scopedModels.map((item) => item.model);
        const globalScope = resolveGlobalScopedModelsState(
          piSettings.global, piSettings.project, allModels, sessionScopedModels, projectTrusted,
        );

        const action = await ctx.ui.custom<SelectorAction>((tui, theme, keybindings, done) => (
          new PModelSelectorComponent(
            tui,
            theme,
            keybindings,
            done,
            {
              allModels,
              scopedModels: sessionScopedModels,
              globalScope,
              preferences: readResolvedPreferences(),
              ...(ctx.model ? { current: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
              defaults: resolveModelDefaultState(piSettings.global, piSettings.project),
              readThinking: () => pi.getThinkingLevel(),
              ...(args.trim() ? { initialQuery: args.trim() } : {}),
              projectTrusted,
            },
            {
              async onToggleModelDefault(model, layer) {
                return serializeScopeWrite(async () => {
                  await maintainConfiguration(ctx, true);
                  const catalog = ctx.modelRegistry.getAll();
                  const fresh = catalog.find((item) => item.provider === model.provider && item.id === model.id);
                  if (!fresh && !ctx.modelRegistry.getError() && catalog.length > 0) {
                    throw new Error("This model was removed while the picker was open. Reopen /pmodel.");
                  }
                  const result = await toggleModelDefault(piSettingsPaths, layer, fresh ?? model, { projectTrusted: ctx.isProjectTrusted() });
                  pendingDefaultsReload ||= result.changed;
                  return result.defaults;
                });
              },
              async onToggleGlobalScope(model) {
                const state = await serializeScopeWrite(async () => {
                  await maintainConfiguration(ctx, true);
                  return toggleGlobalScopedModel(
                    piSettingsPaths, ctx.modelRegistry.getAvailable(), sessionScopedModels, model, projectTrusted,
                  );
                });
                ctx.ui.notify(
                  "Global scoped selection saved. Restart Pi (pi -c) to sync /model, /scoped-models and cycling; /reload is not enough." +
                  (state.projectOverride ? " Project enabledModels still overrides global scope." : ""),
                  "info",
                );
                return state;
              },
              onPreferenceChange(layer, override) {
                if (layer === "project" && !ctx.isProjectTrusted()) throw new Error("Project trust is required to save visibility");
                writePreferenceOverride(preferencePaths, layer, override);
                return readResolvedPreferences();
              },
              onClearProjectPreference(override: PreferenceOverrideTarget) {
                if (!ctx.isProjectTrusted()) throw new Error("Project trust is required to clear visibility");
                clearProjectOverride(preferencePaths, override);
                return readResolvedPreferences();
              },
              onError(error) {
                ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
              },
            },
          )
        ));

        try {
          await serializeScopeWrite(() => maintainConfiguration(ctx, true));
          const defaultsChanged = await applyAction(pi, ctx, action, piSettingsPaths);
          pendingDefaultsReload ||= defaultsChanged;
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        if (pendingDefaultsReload) {
          try {
            await ctx.reload();
          } catch (error) {
            ctx.ui.notify(`Could not reload default caches: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
          return;
        }
      },
    });
  };
}

export default createPModelExtension();

export type { Model };
