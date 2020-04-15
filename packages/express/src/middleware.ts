// Copyright IBM Corp. 2020. All Rights Reserved.
// Node module: @loopback/express
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

import {
  Binding,
  BindingScope,
  BindingTemplate,
  compareBindingsByTag,
  Constructor,
  Context,
  createBindingFromClass,
  InvocationResult,
  isProviderClass,
  Provider,
  transformValueOrPromise,
  ValueOrPromise,
} from '@loopback/context';
import {extensionFilter, extensionFor} from '@loopback/core';
import assert from 'assert';
import debugFactory from 'debug';
import {
  buildName,
  createInterceptor,
  defineInterceptorProvider,
  toInterceptor,
} from './middleware-interceptor';
import {
  DEFAULT_MIDDLEWARE_CHAIN,
  ExpressMiddlewareFactory,
  ExpressRequestHandler,
  InvokeMiddlewareOptions,
  Middleware,
  MiddlewareBindingOptions,
  MiddlewareChain,
  MiddlewareContext,
  MIDDLEWARE_CONTEXT,
} from './types';

const debug = debugFactory('loopback:middleware');

/**
 * An adapter function to create a LoopBack middleware that invokes the list
 * of Express middleware handler functions in the order of their positions
 *
 * @param handlers A list of Express middleware handler functions
 * @returns A LoopBack middleware function that wraps the list of Express
 * middleware
 */
export function toMiddleware(...handlers: ExpressRequestHandler[]): Middleware {
  const middlewareList = handlers.map(handler =>
    toInterceptor<MiddlewareContext>(handler),
  );
  return (middlewareCtx, next) => {
    const middlewareChain = new MiddlewareChain(middlewareCtx, middlewareList);
    const result = middlewareChain.invokeInterceptors();
    return transformValueOrPromise(result, val =>
      val === middlewareCtx.response ? val : next(),
    );
  };
}

/**
 * An adapter function to create a LoopBack middleware from Express middleware
 * factory function and configuration object.
 *
 * @param middlewareFactory - Express middleware factory function
 * @param middlewareConfig - Express middleware config
 *
 * @returns A LoopBack middleware function that wraps the Express middleware
 */
export function createMiddleware<CFG>(
  middlewareFactory: ExpressMiddlewareFactory<CFG>,
  middlewareConfig?: CFG,
): Middleware {
  return createInterceptor<CFG, MiddlewareContext>(
    middlewareFactory,
    middlewareConfig,
  );
}

/**
 * Bind a Express middleware to the given context
 *
 * @param ctx - Context object
 * @param middlewareFactory - Middleware module name or factory function
 * @param middlewareConfig - Middleware config
 * @param options - Options for registration
 *
 * @typeParam CFG - Configuration type
 */
export function registerExpressMiddleware<CFG>(
  ctx: Context,
  middlewareFactory: ExpressMiddlewareFactory<CFG>,
  middlewareConfig?: CFG,
  options: MiddlewareBindingOptions = {},
): Binding<Middleware> {
  options = {injectConfiguration: true, ...options};
  options.chain = options.chain ?? DEFAULT_MIDDLEWARE_CHAIN;
  if (!options.injectConfiguration) {
    let key = options.key;
    if (!key) {
      const name = buildName(middlewareFactory);
      if (name) key = `interceptors.${name}`;
    }
    const middleware = createMiddleware(middlewareFactory, middlewareConfig);
    return registerMiddleware(ctx, middleware, options);
  }

  const providerClass = defineInterceptorProvider<CFG, MiddlewareContext>(
    middlewareFactory,
    options.providerClassName,
  );
  const binding = registerMiddleware(ctx, providerClass, options);
  if (middlewareConfig != null) {
    ctx.configure(binding.key).to(middlewareConfig);
  }
  return binding;
}

/**
 * Template function for middleware bindings
 * @param options - Options to configure the binding
 */
export function asMiddleware(
  options: MiddlewareBindingOptions = {},
): BindingTemplate<Middleware> {
  return function middlewareBindingTemplate(binding) {
    binding
      .apply(extensionFor(options.chain ?? DEFAULT_MIDDLEWARE_CHAIN))
      .tag({group: options.group ?? ''});
  };
}

/**
 * Bind the middleware function or provider class to the context
 * @param ctx - Context object
 * @param middleware - Middleware function or provider class
 * @param options - Middleware binding options
 */
export function registerMiddleware(
  ctx: Context,
  middleware: Middleware | Constructor<Provider<Middleware>>,
  options: MiddlewareBindingOptions,
) {
  if (isProviderClass(middleware as Constructor<Provider<Middleware>>)) {
    const binding = createMiddlewareBinding(
      middleware as Constructor<Provider<Middleware>>,
      options,
    );
    ctx.add(binding);
    return binding;
  }
  assert(options.key, 'options.key is missing.');
  return ctx
    .bind(options.key!)
    .to(middleware as Middleware)
    .apply(asMiddleware(options));
}

/**
 * Create a binding for the middleware provider class
 *
 * @param middlewareProviderClass - Middleware provider class
 * @param options - Options to create middleware binding
 *
 */
export function createMiddlewareBinding(
  middlewareProviderClass: Constructor<Provider<Middleware>>,
  options: MiddlewareBindingOptions = {},
) {
  options.chain = options.chain ?? DEFAULT_MIDDLEWARE_CHAIN;
  const binding = createBindingFromClass(middlewareProviderClass, {
    defaultScope: BindingScope.TRANSIENT,
    namespace: 'middleware',
    key: options.key,
  }).apply(asMiddleware(options));
  return binding;
}

/**
 * Discover and invoke registered middleware in a chain for the given extension
 * point.
 *
 * @param middlewareCtx - Middleware context
 * @param options - Options to invoke the middleware chain
 */
export function invokeMiddleware(
  middlewareCtx: MiddlewareContext,
  options?: InvokeMiddlewareOptions,
): ValueOrPromise<InvocationResult> {
  debug(
    'Invoke middleware chain for %s %s with options',
    middlewareCtx.request.method,
    middlewareCtx.request.originalUrl,
    options,
  );
  const {chain = DEFAULT_MIDDLEWARE_CHAIN, orderedGroups} = options ?? {};
  // Find extensions for the given extension point binding
  const filter = extensionFilter(chain);
  if (debug.enabled) {
    debug(
      'Middleware for extension point "%s":',
      chain,
      middlewareCtx.find(filter).map(b => b.key),
    );
  }
  const _middlewareChain = new MiddlewareChain(
    middlewareCtx,
    filter,
    compareBindingsByTag('group', orderedGroups),
  );
  return _middlewareChain.invokeInterceptors();
}

/**
 * Invoke a list of Express middleware handler functions
 *
 * @example
 * ```ts
 * import cors from 'cors';
 * import helmet from 'helmet';
 * import morgan from 'morgan';
 * import {MiddlewareContext, invokeExpressMiddleware} from '@loopback/express';
 *
 * // ... Either an instance of `MiddlewareContext` is passed in or a new one
 * // can be instantiated from Express request and response objects
 *
 * const middlewareCtx = new MiddlewareContext(request, response);
 * const finished = await invokeExpressMiddleware(
 *   middlewareCtx,
 *   cors(),
 *   helmet(),
 *   morgan('combined'));
 *
 * if (finished) {
 *   // Http response is sent by one of the middleware
 * } else {
 *   // Http response is yet to be produced
 * }
 * ```
 * @param middlewareCtx - Middleware context
 * @param handlers - A list of Express middleware handler functions
 */
export function invokeExpressMiddleware(
  middlewareCtx: MiddlewareContext,
  ...handlers: ExpressRequestHandler[]
): ValueOrPromise<boolean> {
  const middleware = toMiddleware(...handlers);
  debug(
    'Invoke Express middleware for %s %s',
    middlewareCtx.request.method,
    middlewareCtx.request.originalUrl,
  );
  // Invoke the middleware with a no-op next()
  const result = middleware(middlewareCtx, () => undefined);
  // Check if the response is finished
  return transformValueOrPromise(result, val => val === middlewareCtx.response);
}

/**
 * An adapter function to create an Express middleware handler to discover and
 * invoke registered LoopBack-style middleware in the context.
 * @param ctx - Context object to discover registered middleware
 */
export function toExpressMiddleware(ctx: Context): ExpressRequestHandler {
  return async (req, res, next) => {
    const middlewareCtx = new MiddlewareContext(req, res, ctx);
    // Set the middleware context to `request` object
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any)[MIDDLEWARE_CONTEXT] = middlewareCtx;

    try {
      const result = await invokeMiddleware(middlewareCtx);
      if (result !== res) {
        next();
      }
    } catch (err) {
      next(err);
    }
  };
}
