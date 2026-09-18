import { describe, it, expect } from 'vitest';
import { CapabilityRegistry } from '../../../src/capabilities/registry.js';
import { ToolDisabledError } from '../../../src/errors/tool-errors.js';
import { buildConfig } from '../../helpers/build-config.js';

describe('default-deny capability registry', () => {
  it('denies a tool with no configuration entry at all', () => {
    const config = buildConfig({
      mutations: { enabled: true, default: 'deny', tools: {} } as never,
    });
    const registry = new CapabilityRegistry(config, true);
    expect(registry.isEnabled('pause_campaign')).toBe(false);
    expect(registry.enabledMutationTools()).toEqual([]);
  });

  it('denies a tool explicitly disabled', () => {
    const config = buildConfig({
      mutations: {
        enabled: true,
        default: 'deny',
        tools: { pause_campaign: { enabled: false, maxResourcesPerCall: 1 } },
      } as never,
    });
    expect(new CapabilityRegistry(config, true).isEnabled('pause_campaign')).toBe(false);
  });

  it('enables a tool explicitly enabled', () => {
    const registry = new CapabilityRegistry(buildConfig(), true);
    expect(registry.isEnabled('pause_campaign')).toBe(true);
    expect(registry.enabledMutationTools()).toHaveLength(15);
  });

  it('the global mutations switch denies everything', () => {
    const config = buildConfig({
      mutations: { ...buildConfig().mutations, enabled: false },
    });
    const registry = new CapabilityRegistry(config, true);
    expect(registry.mutationsGloballyEnabled).toBe(false);
    expect(registry.enabledMutationTools()).toEqual([]);
    expect(registry.reasonFor('pause_campaign')).toBe('mutations_disabled');
  });

  it('the environment kill switch denies everything independently', () => {
    const registry = new CapabilityRegistry(buildConfig(), false);
    expect(registry.mutationsGloballyEnabled).toBe(false);
    expect(registry.enabledMutationTools()).toEqual([]);
    expect(registry.reasonFor('pause_campaign')).toBe('kill_switch');
    expect(registry.suppressionReport()).toHaveLength(15);
  });

  it('assertEnabled throws TOOL_DISABLED with the reason', () => {
    const registry = new CapabilityRegistry(buildConfig(), false);
    try {
      registry.assertEnabled('set_campaign_budget');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolDisabledError);
      expect((err as ToolDisabledError).code).toBe('TOOL_DISABLED');
      expect((err as ToolDisabledError).details.reason).toBe('kill_switch');
    }
  });

  it('returns the typed policy for an enabled tool', () => {
    const registry = new CapabilityRegistry(buildConfig(), true);
    expect(registry.assertEnabled('pause_ad').maxResourcesPerCall).toBe(10);
    expect(registry.assertEnabled('update_tracking_parameters').allowFinalUrlChanges).toBe(false);
  });
});
