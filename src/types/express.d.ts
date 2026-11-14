export type AuthContext = {
  userId: number;
  sessionId: number;
  workspaceId: number;
  role: 'owner' | 'member';
};

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}
