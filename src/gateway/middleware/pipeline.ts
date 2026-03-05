import type { MessageHandler } from '../../shared/messaging';
import type { MessageMiddleware } from './middleware.types';

/**
 * Compose an array of middlewares around a base handler.
 * Execution order: middlewares[0] runs first (outermost), middlewares[last] runs last (closest to handler).
 *
 * @example
 * const handler = composeMiddleware([auth, rateLimit, transform], baseHandler);
 */
export function composeMiddleware(
  middlewares: MessageMiddleware[],
  handler: MessageHandler,
): MessageHandler {
  // Apply middlewares in reverse order so the first middleware in the array
  // wraps the outermost layer.
  let current = handler;
  for (let i = middlewares.length - 1; i >= 0; i--) {
    current = middlewares[i](current);
  }
  return current;
}

/**
 * Returns a function that wraps any handler with the given middlewares.
 * Useful for deferred composition.
 *
 * @example
 * const wrap = createMiddlewarePipeline([auth, rateLimit, transform]);
 * const handler = wrap(baseHandler);
 */
export function createMiddlewarePipeline(
  middlewares: MessageMiddleware[],
): (handler: MessageHandler) => MessageHandler {
  return (handler) => composeMiddleware(middlewares, handler);
}
