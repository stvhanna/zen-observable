// === Non-Promise Job Queueing ===

const enqueueJob = (function() {

    // Node
    if (typeof global !== "undefined" &&
        typeof process !== "undefined" &&
        process.nextTick) {

        return global.setImmediate ?
            fn => { global.setImmediate(fn) } :
            fn => { process.nextTick(fn) };
    }

    // Newish Browsers
    let Observer = self.MutationObserver || self.WebKitMutationObserver;

    if (Observer) {

        let div = document.createElement("div"),
            twiddle = _=> div.classList.toggle("x"),
            queue = [];

        let observer = new Observer(_=> {

            if (queue.length > 1)
                twiddle();

            while (queue.length > 0)
                queue.shift()();
        });

        observer.observe(div, { attributes: true });

        return fn => {

            queue.push(fn);

            if (queue.length === 1)
                twiddle();
        };
    }

    // Fallback
    return fn => { setTimeout(fn, 0) };

})();

// === Symbol Polyfills ===

function polyfillSymbol(name) {

    if (symbolsSupported() && !Symbol[name])
        Object.defineProperty(Symbol, name, { value: Symbol(name) });
}

function symbolsSupported() {

    return typeof Symbol === "function";
}

function hasSymbol(name) {

    return symbolsSupported() && Boolean(Symbol[name]);
}

function getSymbol(name) {

    return hasSymbol(name) ? Symbol[name] : "@@" + name;
}

polyfillSymbol("observable");

// === Abstract Operations ===

function getMethod(obj, key) {

    let value = obj[key];

    if (value == null)
        return undefined;

    if (typeof value !== "function")
        throw new TypeError(value + " is not a function");

    return value;
}

function getSpecies(ctor) {

    let symbol = getSymbol("species");
    return symbol ? ctor[symbol] : ctor;
}

function addMethods(target, methods) {

    Object.keys(methods).forEach(k => {

        let desc = Object.getOwnPropertyDescriptor(methods, k);
        desc.enumerable = false;
        Object.defineProperty(target, k, desc);
    });
}

function cleanupSubscription(observer) {

    // Assert:  observer._observer is undefined

    let cleanup = observer._cleanup;

    if (!cleanup)
        return;

    // Drop the reference to the cleanup function so that we won't call it
    // more than once
    observer._cleanup = undefined;

    // Call the cleanup function
    cleanup();
}

function subscriptionClosed(observer) {

    return observer._observer === undefined;
}

function SubscriptionObserver(observer, subscriber) {

    // Assert: subscriber is callable

    // The observer must be an object
    if (Object(observer) !== observer)
        throw new TypeError("Observer must be an object");

    this._observer = observer;
    this._cleanup = undefined;

    try {

        // Call the subscriber function
        let cleanup = subscriber.call(undefined, this);

        // The return value must be undefined, null, or a function
        if (cleanup != null && typeof cleanup !== "function")
            throw new TypeError(cleanup + " is not a function");

        this._cleanup = cleanup;

    } catch (e) {

        // If an error occurs during startup, then attempt to send the error
        // to the observer
        this.error(e);
        return;
    }

    // If the stream is already finished, then perform cleanup
    if (subscriptionClosed(this))
        cleanupSubscription(this);
}

addMethods(SubscriptionObserver.prototype = {}, {

    cancel() {

        if (subscriptionClosed(this))
            return;

        this._observer = undefined;
        cleanupSubscription(this);
    },

    get closed() { return subscriptionClosed(this) },

    next(value) {

        // If the stream if closed, then return undefined
        if (subscriptionClosed(this))
            return undefined;

        let observer = this._observer;

        try {

            let m = getMethod(observer, "next");

            // If the observer doesn't support "next", then return undefined
            if (!m)
                return undefined;

            // Send the next value to the sink
            return m.call(observer, value);

        } catch (e) {

            // If the observer throws, then close the stream and rethrow the error
            try { this.cancel() }
            finally { throw e }
        }
    },

    error(value) {

        // If the stream is closed, throw the error to the caller
        if (subscriptionClosed(this))
            throw value;

        let observer = this._observer;
        this._observer = undefined;

        try {

            let m = getMethod(observer, "error");

            // If the sink does not support "error", then throw the error to the caller
            if (!m)
                throw value;

            value = m.call(observer, value);

        } catch (e) {

            try { cleanupSubscription(this) }
            finally { throw e }
        }

        cleanupSubscription(this);

        return value;
    },

    complete(value) {

        // If the stream is closed, then return undefined
        if (subscriptionClosed(this))
            return undefined;

        let observer = this._observer;
        this._observer = undefined;

        try {

            let m = getMethod(observer, "complete");

            // If the sink does not support "complete", then return undefined
            value = m ? m.call(observer, value) : undefined;

        } catch (e) {

            try { cleanupSubscription(this) }
            finally { throw e }
        }

        cleanupSubscription(this);

        return value;
    },

});

export function Observable(subscriber) {

    // The stream subscriber must be a function
    if (typeof subscriber !== "function")
        throw new TypeError("Observable initializer must be a function");

    this._subscriber = subscriber;
}

addMethods(Observable.prototype, {

    subscribe(observer) {

        // Wrap the observer in order to maintain observation invariants
        observer = new SubscriptionObserver(observer, this._subscriber);
        return _=> { observer.cancel() };
    },

    forEach(fn) {

        return new Promise((resolve, reject) => {

            if (typeof fn !== "function")
                throw new TypeError(fn + " is not a function");

            this.subscribe({

                next(value) {

                    try { return fn(value) }
                    catch (x) { reject(x) }
                },

                error: reject,
                complete: resolve,
            });
        });
    },

    map(fn) {

        if (typeof fn !== "function")
            throw new TypeError(fn + " is not a function");

        let C = getSpecies(this.constructor);

        return new C(observer => this.subscribe({

            next(value) {

                try { value = fn(value) }
                catch (e) { return observer.error(e) }

                return observer.next(value);
            },

            error(value) { return observer.error(value) },
            complete(value) { return observer.complete(value) },
        }));
    },

    filter(fn) {

        if (typeof fn !== "function")
            throw new TypeError(fn + " is not a function");

        let C = getSpecies(this.constructor);

        return new C(observer => this.subscribe({

            next(value) {

                try { if (!fn(value)) return undefined; }
                catch (e) { return observer.error(e) }

                return observer.next(value);
            },

            error(value) { return observer.error(value) },
            complete(value) { return observer.complete(value) },
        }));
    },

});

Object.defineProperty(Observable.prototype, getSymbol("observable"), {
    value: function() { return this },
    writable: true,
    configurable: true,
});

addMethods(Observable, {

    from(x) {

        let C = typeof this === "function" ? this : Observable;

        if (x == null)
            throw new TypeError(x + " is not an object");

        let method = getMethod(x, getSymbol("observable"));

        if (method) {

            let observable = method.call(x);

            if (Object(observable) !== observable)
                throw new TypeError(observable + " is not an object");

            if (observable.constructor === C)
                return observable;

            return new C(observer => observable.subscribe(observer));
        }

        return new C(observer => {

            enqueueJob(_=> {

                if (observer.closed)
                    return;

                // Assume that the object is iterable.  If not, then the observer
                // will receive an error.
                try {

                    if (hasSymbol("iterator")) {

                        for (let item of x) {

                            observer.next(item);

                            if (observer.closed)
                                return;
                        }

                    } else {

                        if (!Array.isArray(x))
                            throw new Error(x + " is not an Array");

                        for (let i = 0; i < x.length; ++i) {

                            observer.next(x[i]);

                            if (observer.closed)
                                return;
                        }
                    }

                } catch (x) {

                    // If observer.next throws an error, then the subscription will
                    // be closed and the error method will simply rethrow
                    observer.error(x);
                    return;
                }

                observer.complete();
            });
        });
    },

    of(...items) {

        let C = typeof this === "function" ? this : Observable;

        return new C(observer => {

            enqueueJob(_=> {

                if (observer.closed)
                    return;

                for (let i = 0; i < items.length; ++i) {

                    observer.next(items[i]);

                    if (observer.closed)
                        return;
                }

                observer.complete();
            });
        });
    },

});

Object.defineProperty(Observable, getSymbol("species"), {
    get() { return this },
    configurable: true,
});
