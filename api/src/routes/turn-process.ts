import { Router, type Request, type Response } from 'express';
import * as registry from '../registry.js';
import { itemDetailFor, itemImagesFor, itemsFor, lookupTurnProcess, type TurnProcessLookup, type TurnSelector } from '../process/service.js';
import type { ConversationSegment, ManagedSession } from '../types.js';
import { turnGitChanges } from '../process/git.js';
import { itemsOf } from '../process/classify.js';
import { claudeItemDetail, claudeItemImages } from '../process/claude.js';
import { codexItemDetail, codexItemImages } from '../process/codex.js';
import { loadProcessImage, ProcessImageError, type RawProcessImage } from '../process/images.js';
import { readSubagentProcess } from '../process/subagents.js';
import { sendError } from './errors.js';
import { requireLogin } from './login-guard.js';

// A turn's process beyond the brief in the conversation's detail: its
// level-3 list and an item's level-4 details (docs/specs/turn-process-
// levels.md §5). Both can show command lines, their output and diffs —
// anything a CLI read, secrets included — so only the user's own login
// may ask, never the local tool token a CLI holds (§6). An item id is
// only ever compared with the ids inside that one turn.
export const turnProcessRouter = Router();

const ITEM_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const IMAGE_INDEX = /^\d{1,3}$/;

// One of an item's images (capability process_images), from the list the
// transcript gives for that item: only its index comes from the request.
async function sendProcessImage(res: Response, images: readonly RawProcessImage[] | null, index: string): Promise<void> {
  const image = images?.[Number(index)];
  if (!image) {
    sendError(res, 404, 'process_image_not_found', 'no such image in this item');
    return;
  }
  try {
    const { type, bytes } = await loadProcessImage(image);
    res.setHeader('Content-Type', type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(bytes);
  } catch (error) {
    if (!(error instanceof ProcessImageError)) throw error;
    if (error.code === 'blocked') sendError(res, 403, 'path_sensitive', error.message);
    else if (error.code === 'unsupported_media') sendError(res, 415, 'unsupported_media', error.message);
    else if (error.code === 'too_large') sendError(res, 413, 'unsupported_media', error.message);
    else sendError(res, 404, 'process_image_not_found', error.message);
  }
}

function selectorOf(value: string): TurnSelector | null {
  if (value === 'open') return 'open';
  return /^[1-9]\d{0,8}$/.test(value) ? Number(value) : null;
}

async function resolve(req: Request, res: Response): Promise<{ session: ManagedSession; conversation: ConversationSegment; lookup: Extract<TurnProcessLookup, { status: 'ok' | 'none' }> } | null> {
  const selector = selectorOf(String(req.params.index));
  if (selector === null) {
    sendError(res, 400, 'invalid_request', 'turn index must be a positive number or "open"');
    return null;
  }
  const session = await registry.getSession(String(req.params.id));
  if (!session) {
    sendError(res, 404, 'not_found', 'not found');
    return null;
  }
  const conversation = await registry.getConversation(session.id, String(req.params.conversationId));
  if (!conversation) {
    sendError(res, 404, 'conversation_not_found', 'conversation not found');
    return null;
  }
  const lookup = await lookupTurnProcess(session, conversation, selector);
  if (lookup.status === 'turn_not_found') {
    sendError(res, 404, 'turn_not_found', 'turn not found');
    return null;
  }
  if (lookup.status === 'transcript_missing') {
    sendError(res, 410, 'transcript_missing', 'the CLI transcript of this conversation no longer exists');
    return null;
  }
  if (lookup.status === 'unsupported') {
    sendError(res, 409, 'process_unsupported', 'this CLI\'s transcripts are not read for a turn\'s process');
    return null;
  }
  return { session, conversation, lookup: lookup as Extract<TurnProcessLookup, { status: 'ok' | 'none' }> };
}

turnProcessRouter.get('/:id/conversations/:conversationId/turns/:index/process', requireLogin, async (req, res) => {
  const found = await resolve(req, res);
  if (!found) return;
  const { lookup, conversation } = found;
  if (lookup.status !== 'ok') {
    res.json({ provider: conversation.provider, process: lookup.brief, items: [] });
    return;
  }
  res.json({ provider: conversation.provider, process: lookup.brief, items: itemsFor(lookup.turn) });
});

turnProcessRouter.get('/:id/conversations/:conversationId/turns/:index/process/items/:itemId', requireLogin, async (req, res) => {
  const itemId = String(req.params.itemId);
  if (!ITEM_ID.test(itemId)) {
    sendError(res, 400, 'invalid_request', 'invalid item id');
    return;
  }
  const found = await resolve(req, res);
  if (!found) return;
  const detail = found.lookup.status === 'ok' ? itemDetailFor(found.lookup, itemId) : null;
  if (!detail) {
    sendError(res, 404, 'process_item_not_found', 'no such item in this turn');
    return;
  }
  res.json(detail);
});

turnProcessRouter.get('/:id/conversations/:conversationId/turns/:index/process/items/:itemId/images/:image', requireLogin, async (req, res) => {
  const itemId = String(req.params.itemId);
  if (!ITEM_ID.test(itemId) || !IMAGE_INDEX.test(String(req.params.image))) {
    sendError(res, 400, 'invalid_request', 'invalid item or image');
    return;
  }
  const found = await resolve(req, res);
  if (!found) return;
  await sendProcessImage(res, found.lookup.status === 'ok' ? itemImagesFor(found.lookup, itemId) : null, String(req.params.image));
});

// The commits made while the turn went on. Works whether or not the transcript is still there: its times come
// from the stored turns; the transcript only adds which folders.
turnProcessRouter.get('/:id/conversations/:conversationId/turns/:index/git', requireLogin, async (req, res) => {
  const selector = selectorOf(String(req.params.index));
  if (typeof selector !== 'number') {
    sendError(res, 400, 'invalid_request', 'turn index must be a positive number');
    return;
  }
  const session = await registry.getSession(String(req.params.id));
  if (!session) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  const conversation = await registry.getConversation(session.id, String(req.params.conversationId));
  if (!conversation) {
    sendError(res, 404, 'conversation_not_found', 'conversation not found');
    return;
  }
  try {
    const changes = await turnGitChanges(session, conversation, selector);
    if (!changes) {
      sendError(res, 404, 'turn_not_found', 'turn not found');
      return;
    }
    res.json(changes);
  } catch (error) {
    sendError(res, 502, 'git_failed', error instanceof Error ? error.message : 'git failed', { reason: 'error' });
  }
});

// A subagent's turn: the same list and details, from its own transcript
// (process/subagents.ts). `open` is its latest turn.
async function subagentTurn(req: Request, res: Response) {
  const agentId = String(req.params.agentId);
  const selector = selectorOf(String(req.params.index));
  if (!/^[A-Za-z0-9-]{6,64}$/.test(agentId) || selector === null) {
    sendError(res, 400, 'invalid_request', 'invalid subagent or turn');
    return null;
  }
  const session = await registry.getSession(String(req.params.id));
  if (!session) {
    sendError(res, 404, 'not_found', 'not found');
    return null;
  }
  const process = await readSubagentProcess(session, agentId);
  if (!process) {
    sendError(res, 404, 'subagent_not_found', 'subagent not found');
    return null;
  }
  const turn = selector === 'open' ? process.turns.at(-1) : process.turns[selector - 1];
  if (!turn) {
    sendError(res, 404, 'turn_not_found', 'turn not found');
    return null;
  }
  return { process, turn };
}

turnProcessRouter.get('/:id/subagents/:agentId/turns/:index/process', requireLogin, async (req, res) => {
  const found = await subagentTurn(req, res);
  if (!found) return;
  const { process, turn } = found;
  res.json({
    provider: process.provider,
    process: { status: 'available', open: false, parts: [], counts: turn.counts },
    items: itemsOf(turn.events, (event) => event.type === 'tool' || (event.type === 'thinking' && event.hasText)),
  });
});

turnProcessRouter.get('/:id/subagents/:agentId/turns/:index/process/items/:itemId', requireLogin, async (req, res) => {
  const itemId = String(req.params.itemId);
  if (!ITEM_ID.test(itemId)) {
    sendError(res, 400, 'invalid_request', 'invalid item id');
    return;
  }
  const found = await subagentTurn(req, res);
  if (!found) return;
  const { process, turn } = found;
  const detail = process.provider === 'claude' ? claudeItemDetail(process.records, turn, itemId) : codexItemDetail(process.records, turn, itemId);
  if (!detail) {
    sendError(res, 404, 'process_item_not_found', 'no such item in this turn');
    return;
  }
  res.json(detail);
});

turnProcessRouter.get('/:id/subagents/:agentId/turns/:index/process/items/:itemId/images/:image', requireLogin, async (req, res) => {
  const itemId = String(req.params.itemId);
  if (!ITEM_ID.test(itemId) || !IMAGE_INDEX.test(String(req.params.image))) {
    sendError(res, 400, 'invalid_request', 'invalid item or image');
    return;
  }
  const found = await subagentTurn(req, res);
  if (!found) return;
  const { process, turn } = found;
  const images = process.provider === 'claude' ? claudeItemImages(process.records, turn, itemId) : codexItemImages(process.records, turn, itemId);
  await sendProcessImage(res, images, String(req.params.image));
});
