import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { PModelSelectorComponent, type SelectorAction } from "./src/model-selector.js";
import { reconcileProjectConfiguration } from "./src/configuration.js";
import { filterAuthenticatedModels, readAuthProviderIds } from "./src/auth-providers.js";
import {
  clearProjectOverride,
  cleanupAuthenticatedPreferences,
  getPreferencePaths,
  readPreferenceLayers,
  resolvePreferences,
  writePreferenceOverride,
  type PreferenceOverrideTarget,
} from "./src/preferences.js";
import {
  clearProjectModelDefault,
  cleanupInvalidModelDefaults,
  getPiSettingsPaths,
  readPiSettingsLayers,
  resolveModelDefaultState,
  toggleModelDefault,
} from "./src/pi-settings.js";
import {
  cleanupGlobalScopedModels,
  resolveGlobalScopedModelsState,
  resolveScopedPattern,
  saveGlobalScopedModels,
} from "./src/scoped-models.js";

async function applyAction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  action: SelectorAction,
  paths: ReturnType<typeof getPiSettingsPaths>,
): Promise<boolean> {
  if (action.type === "cancel" || action.type === "save-global-scope") return false;

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

async function synchronizeScopedModels(
  ctx: ExtensionCommandContext,
  paths: ReturnType<typeof getPiSettingsPaths>,
): Promise<boolean> {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return false;
  const result = await ctx.switchSession(sessionFile, {
    withSession(freshContext) {
      const projectTrusted = freshContext.isProjectTrusted();
      const settings = readPiSettingsLayers(paths, { projectTrusted });
      const providerIds = readAuthProviderIds();
      const availableModels = filterAuthenticatedModels(freshContext.modelRegistry.getAvailable(), providerIds);
      const sessionModels = filterAuthenticatedModels(freshContext.scopedModels.map(({ model }) => model), providerIds);
      const state = resolveGlobalScopedModelsState(
        settings.global,
        settings.project,
        availableModels,
        sessionModels,
        projectTrusted,
      );
      const unresolvedExact = (settings.global.enabledModels ?? []).filter((pattern) => {
        const reference = pattern.trim();
        const slash = reference.indexOf("/");
        const isPattern = /[*?\[\]{}]/.test(reference) || /[+@!]\(/.test(reference);
        return slash > 0 && !isPattern && resolveScopedPattern(pattern, availableModels).length === 0;
      });
      const synchronized = !state.sessionDiffers && unresolvedExact.length === 0;
      freshContext.ui.notify(
        synchronized
          ? "Global scoped selection saved and synchronized with /model, /scoped-models and model cycling."
          : unresolvedExact.length > 0
            ? `Global scoped selection saved, but these account models are still unavailable: ${unresolvedExact.join(", ")}.`
            : "Global scoped selection saved, but project enabledModels or startup --models still controls this session.",
        synchronized ? "info" : "warning",
      );
      return Promise.resolve();
    },
  });
  return !result.cancelled;
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
      const providerIds = readAuthProviderIds();
      const result = await cleanupGlobalScopedModels(
        getPiSettingsPaths(ctx.cwd),
        filterAuthenticatedModels(catalog, providerIds),
        {
          availableModels: filterAuthenticatedModels(ctx.modelRegistry.getAvailable(), providerIds),
          registeredProviders: providerIds,
          authoritativeProviders: true,
          ...(catalogError ? { catalogError } : {}),
        },
      );
      if (!ctx.hasUI) return;
      if (result.removedPatterns.length > 0) {
        ctx.ui.notify(
          `Cleaned global enabledModels: ${result.removedPatterns.join(", ")}. Restart Pi to refresh the active scope.`,
          "warning",
        );
      } else if (result.skippedReason) {
        ctx.ui.notify(`Automatic global scope cleanup skipped: ${catalogError ?? result.skippedReason}`, "warning");
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
          // Match the official /scoped-models refresh path. Dynamic account
          // providers may have no models in a newly started process until their
          // network-backed catalog has been refreshed.
          const refresh = await ctx.modelRegistry.refresh({ allowNetwork: true, signal: AbortSignal.timeout(15_000) });
          if (refresh.aborted || refresh.errors.size > 0) refreshError = "Model catalog refresh did not complete reliably.";
        } catch {
          refreshError = "Model catalog refresh failed; configured references were retained.";
        }
      }
      const providerIds = readAuthProviderIds();
      const catalog = filterAuthenticatedModels(ctx.modelRegistry.getAll(), providerIds);
      const paths = getPiSettingsPaths(ctx.cwd);
      const catalogError = refreshError ?? ctx.modelRegistry.getError();
      // Global scope maintenance must not be blocked by malformed project data.
      try {
        await cleanupGlobalScope(ctx, catalog, catalogError);
        if (!catalogError) {
          const removedDefaults = cleanupInvalidModelDefaults(paths, catalog, providerIds, { projectTrusted: ctx.isProjectTrusted() });
          for (const removed of removedDefaults) {
            pendingDefaultsReload = true;
            if (!ctx.hasUI) continue;
            ctx.ui.notify(removed.kind === "provider"
              ? `Provider ${removed.provider} has been deleted; choose a new provider and model.`
              : `Model ${removed.provider}/${removed.id ?? "unknown"} has been deleted; choose a new model.`, "warning");
          }
        }
      } catch (error) {
        reportCleanupFailure(ctx, error);
      }
      cleanupAuthenticatedPreferences(getPreferencePaths(ctx.cwd), catalog, providerIds, { projectTrusted: ctx.isProjectTrusted() });
      const result = (() => {
        try {
          return reconcileProjectConfiguration(getPreferencePaths(ctx.cwd), paths, catalog,
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
      try { await serializeScopeWrite(() => maintainConfiguration(ctx, false)); }
      catch (error) { reportCleanupFailure(ctx, error); }
    });

    let pickerOpen = false;
    const openPModel = async (
      args: string,
      ctx: ExtensionContext,
      reloadDefaults?: () => Promise<void>,
      synchronizeScope?: () => Promise<boolean>,
    ): Promise<void> => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/pmodel requires TUI mode", "error");
        return;
      }
      if (pickerOpen) {
        ctx.ui.notify("/pmodel is already open", "info");
        return;
      }

      pickerOpen = true;
      try {
        try {
          await serializeScopeWrite(() => maintainConfiguration(ctx, true));
        } catch (error) {
          reportCleanupFailure(ctx, error);
        }

        const providerIds = readAuthProviderIds();
        const allModels = filterAuthenticatedModels(ctx.modelRegistry.getAvailable(), providerIds);
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
        const sessionScopedModels = filterAuthenticatedModels(ctx.scopedModels.map((item) => item.model), providerIds);
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
                  const result = await toggleModelDefault(piSettingsPaths, layer, fresh ?? model, {
                    projectTrusted: ctx.isProjectTrusted(),
                  });
                  pendingDefaultsReload ||= result.changed;
                  return result.defaults;
                });
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
          if (action.type === "save-global-scope") {
            const availableModels = filterAuthenticatedModels(ctx.modelRegistry.getAvailable(), readAuthProviderIds());
            const state = await serializeScopeWrite(() => saveGlobalScopedModels(
              piSettingsPaths,
              availableModels,
              sessionScopedModels,
              action.modelIds,
              projectTrusted,
            ));
            if (synchronizeScope && await synchronizeScope()) return;
            if (state.projectOverride) {
              ctx.ui.notify(
                "Global scoped selection saved, but project enabledModels overrides it in this project.",
                "warning",
              );
            }
            ctx.ui.notify(
              "Global scoped selection saved. Restart Pi to synchronize /model, /scoped-models and model cycling.",
              "warning",
            );
            return;
          }
          const defaultsChanged = await applyAction(pi, ctx, action, piSettingsPaths);
          pendingDefaultsReload ||= defaultsChanged;
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        if (pendingDefaultsReload) {
          if (!reloadDefaults) {
            ctx.ui.notify("Default changes were saved. Run /reload to refresh Pi's default caches.", "warning");
            return;
          }
          try {
            await reloadDefaults();
          } catch (error) {
            ctx.ui.notify(`Could not reload default caches: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
          return;
        }
      } finally {
        pickerOpen = false;
      }
    };

    pi.registerShortcut(Key.ctrlShift("e"), {
      description: "Open the provider-grouped model picker",
      handler: async (ctx) => openPModel("", ctx),
    });

    pi.registerCommand("pmodel", {
      description: "Select and organize models by provider without replacing /model",
      handler: async (args, ctx) => openPModel(
        args,
        ctx,
        () => ctx.reload(),
        () => synchronizeScopedModels(ctx, getPiSettingsPaths(ctx.cwd)),
      ),
    });
  };
}

export default createPModelExtension();

export type { Model };
