import { ToolDisabledError, type ToolDisabledReason } from '../errors/tool-errors.js';
import type { AppConfig, PolicyFor } from './schema.js';
import { MUTATION_TOOL_NAMES, type MutationToolName } from './tool-names.js';

export interface SuppressedTool {
  name: MutationToolName;
  reason: ToolDisabledReason;
}

/**
 * Resolves which mutation tools are available.
 *
 * Default-deny: a tool is available only when the global mutation switch is on, the
 * environment kill switch is not set, and the tool has an explicit `enabled: true`
 * entry. An absent key means denied.
 */
export class CapabilityRegistry {
  constructor(
    private readonly config: AppConfig,
    private readonly mutationsEnabledEnv: boolean,
    private readonly installReadOnly = false,
  ) {}

  get mutationsGloballyEnabled(): boolean {
    return this.config.mutations.enabled && this.mutationsEnabledEnv;
  }

  isEnabled(name: MutationToolName): boolean {
    if (!this.mutationsGloballyEnabled) return false;
    return this.config.mutations.tools[name]?.enabled === true;
  }

  policyFor<N extends MutationToolName>(name: N): PolicyFor<N> | undefined {
    return this.config.mutations.tools[name] as PolicyFor<N> | undefined;
  }

  reasonFor(name: MutationToolName): ToolDisabledReason {
    if (!this.mutationsEnabledEnv) return 'kill_switch';
    if (this.installReadOnly) return 'configuration_disabled';
    if (!this.config.mutations.enabled) return 'mutations_disabled';
    void name;
    return 'not_enabled';
  }

  /**
   * Re-check enablement at call time.
   *
   * Disabled tools remain registered and are denied at call time for auditability.
   */
  assertEnabled<N extends MutationToolName>(name: N): PolicyFor<N> {
    if (!this.isEnabled(name)) {
      throw new ToolDisabledError(name, this.reasonFor(name));
    }
    return this.config.mutations.tools[name] as PolicyFor<N>;
  }

  enabledMutationTools(): MutationToolName[] {
    return MUTATION_TOOL_NAMES.filter((n) => this.isEnabled(n));
  }

  suppressionReport(): SuppressedTool[] {
    return MUTATION_TOOL_NAMES.filter((n) => !this.isEnabled(n)).map((name) => ({
      name,
      reason: this.reasonFor(name),
    }));
  }
}
