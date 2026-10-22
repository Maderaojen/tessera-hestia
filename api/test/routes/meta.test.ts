import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { API_CAPABILITIES, CONTRACT_VERSION, RUNTIME_LABELS } from '../../src/contract/index.js';
import { metaRouter } from '../../src/routes/meta.js';
import { runtimeDrivers } from '../../src/runtimes/index.js';

const app = express().use('/meta', metaRouter());

describe('GET /meta', () => {
  it('names the API and contract versions', async () => {
    const response = await request(app).get('/meta');
    expect(response.status).toBe(200);
    expect(response.body.contractVersion).toBe(CONTRACT_VERSION);
    expect(response.body.apiVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(Array.isArray(response.body.capabilities)).toBe(true);
    expect(response.body.capabilities).toContain('native_push');
    expect(response.body.capabilities).toContain('repo_view');
    expect(response.body.capabilities).toContain('continuity');
    expect(response.body.capabilities).toContain('session_trash');
    expect(response.body.capabilities).toContain('recap');
    expect(response.body.capabilities).toContain('usage_analytics');
    expect(response.body.capabilities).toContain('delegation_origin');
    expect(response.body.capabilities).toContain('handoff_options');
    expect(response.body.capabilities).toContain('handoff_brief');
    expect(response.body.capabilities).toContain('session_timeline');
  });

  // The contract's list and the one sent are two lists: one added to the
  // contract only is a feature no client ever turns on (note_trash was).
  it('sends every capability the contract names', async () => {
    const { body } = await request(app).get('/meta');
    expect([...body.capabilities].sort()).toEqual([...API_CAPABILITIES].sort());
  });

  it('names no modules when none is loaded', async () => {
    const { body } = await request(app).get('/meta');
    expect(body.modules).toEqual([]);
  });

  // A module's capabilities join Hestia's own, once each.
  it('adds the loaded modules\' ids and capabilities', async () => {
    const withModules = express().use('/meta', metaRouter([
      { id: 'example', capabilities: ['example_feature', 'recap'], routes: [] },
      { id: 'other', capabilities: [], routes: [] },
    ]));
    const { body } = await request(withModules).get('/meta');
    expect(body.modules).toEqual(['example', 'other']);
    expect(body.capabilities).toEqual(expect.arrayContaining(['example_feature', 'recap']));
    expect(body.capabilities.filter((capability: string) => capability === 'recap')).toHaveLength(1);
  });

  it('lists every driven runtime with its label and what its driver declares', async () => {
    const { body } = await request(app).get('/meta');
    expect(body.runtimes.map((runtime: { id: string }) => runtime.id)).toEqual(runtimeDrivers().map((driver) => driver.runtimeId));
    expect(body.runtimes).toContainEqual({
      id: 'claude-code', provider: 'claude', label: RUNTIME_LABELS['claude-code'],
      capabilities: ['resume', 'clear', 'interrupt', 'startup_prompt', 'quota', 'janus', 'subagents', 'model_switch', 'limit_hit'],
      permissionModes: ['cli_default', 'auto', 'yolo'],
    });
    // Agy has no "decide for me" mode; the legacy Gemini CLI none verified.
    expect(body.runtimes.find((runtime: { id: string }) => runtime.id === 'agy').permissionModes).toEqual(['cli_default', 'yolo']);
    expect(body.runtimes.find((runtime: { id: string }) => runtime.id === 'gemini-cli').permissionModes).toEqual(['cli_default']);
    // Codex's auto, where its sandbox hasn't been found to work (tests never probe).
    expect(body.runtimes.find((runtime: { id: string }) => runtime.id === 'codex-cli').permissionModesUnavailable).toEqual({ auto: 'sandbox_unavailable' });
    expect(body.runtimes.find((runtime: { id: string }) => runtime.id === 'claude-code')).not.toHaveProperty('permissionModesUnavailable');
    // Unverified exit and resume: neither is claimed.
    expect(body.runtimes.find((runtime: { id: string }) => runtime.id === 'gemini-cli').capabilities).toEqual([]);
    expect(body.runtimes.find((runtime: { id: string }) => runtime.id === 'agy').capabilities).toContain('startup_prompt');
    // Legacy Gemini CLI never verified /model.
    expect(body.runtimes.filter((runtime: { capabilities: string[] }) => runtime.capabilities.includes('model_switch')).map((runtime: { id: string }) => runtime.id))
      .toEqual(['claude-code', 'codex-cli', 'agy']);
    // Codex's native subagents are listed too (providers/codex-subagents.ts).
    expect(body.runtimes.filter((runtime: { capabilities: string[] }) => runtime.capabilities.includes('subagents')).map((runtime: { id: string }) => runtime.id))
      .toEqual(['claude-code', 'codex-cli']);
  });

  it('offers the native launch options without their executables or args', async () => {
    const { body } = await request(app).get('/meta');
    expect(body.nativeLaunchOptions).toContainEqual({ id: 'native:claude', provider: 'claude', runtimeId: 'claude-code', label: 'Claude (原生)', source: 'native' });
    expect(body.nativeLaunchOptions).toHaveLength(runtimeDrivers().length);
    for (const option of body.nativeLaunchOptions) expect(Object.keys(option).sort()).toEqual(['id', 'label', 'provider', 'runtimeId', 'source']);
  });
});
