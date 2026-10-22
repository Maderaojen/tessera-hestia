import { describe, expect, it } from 'vitest';
import { buildCapturePaneArgs } from '../src/tmux.js';

describe('buildCapturePaneArgs', () => {
  it('captures just the current screen by default, no ANSI', () => {
    expect(buildCapturePaneArgs('my-session')).toEqual(['capture-pane', '-p', '-t', 'my-session']);
  });

  it('adds -e for ansi', () => {
    expect(buildCapturePaneArgs('my-session', { ansi: true })).toEqual([
      'capture-pane',
      '-p',
      '-t',
      'my-session',
      '-e',
    ]);
  });

  it('adds -S -<n> for history depth, never resizing the pane', () => {
    expect(buildCapturePaneArgs('my-session', { history: 100 })).toEqual([
      'capture-pane',
      '-p',
      '-t',
      'my-session',
      '-S',
      '-100',
    ]);
  });

  it('combines ansi and history', () => {
    expect(buildCapturePaneArgs('my-session', { ansi: true, history: 20 })).toEqual([
      'capture-pane',
      '-p',
      '-t',
      'my-session',
      '-e',
      '-S',
      '-20',
    ]);
  });
});
