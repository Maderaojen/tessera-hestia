export type SearchPart = 'user' | 'followUp' | 'assistant';

export type SearchHit = {
  sessionId: string;
  sessionNumber: number;
  conversationId: string;
  conversationSequence: number;
  turnIndex: number;
  part: SearchPart;
  followUpIndex: number | null;
  at: string | null;
  snippet: string;
};

export type SessionSearchPage = { results: SearchHit[]; nextCursor: string | null };
