// Declaration merge so `req.userId` is typed without resorting to a
// symbol-keyed cast in middleware. Set by `requireUser` after the
// session cookie is verified; read by `getUserId` (which throws if
// it's missing — i.e. the route forgot to mount the middleware).
//
// Keep this file an ambient declaration: no top-level imports or it'll
// stop merging into the global namespace and need to be `export {}`d.
// The `import('express')` namespace reference is a type-only ref that
// doesn't break ambience.

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export {};
