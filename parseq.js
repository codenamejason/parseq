// parseq.js

// Better living through asynchronicity!

/*jslint node */

/*property
    concat, create, evidence, fallback, forEach, freeze, isArray, isSafeInteger,
    keys, length, min, parallel, parallel_object, push, race, sequence, some
*/

function make_error(factory_name, reason, evidence) {

// Make an error report object. These will be used for exceptions and callback
// errors.

    const report = new Error("parseq." + factory_name + (
        (reason === undefined)
            ? ""
            : ": " + reason
    ));
    report.evidence = evidence;
    return report;
}

function is_callback(callback) {

// A 'callback' function takes two arguments, 'success' and 'error'.

    return typeof callback === "function" && callback.length === 2;
}

function check_callback(callback, factory_name) {
    if (!is_callback(callback)) {
        throw make_error(factory_name, "Not a callback.", callback);
    }
}

function check_requestor_array(requestor_array, factory_name) {

// A requestor array contains only requestors. A requestor is a function
// that takes one or two arguments: 'callback' and optionally 'initial_value'.

    if (
        !Array.isArray(requestor_array)
        || requestor_array.length < 1
        || requestor_array.some(function (requestor) {
            return (
                typeof requestor !== "function"
                || requestor.length < 1
                || requestor.length > 2
            );
        })
    ) {
        throw make_error(
            factory_name,
            "Bad requestors array.",
            requestor_array
        );
    }
}

function run(
    factory_name,
    requestor_array,
    initial_value,
    action,
    timeout,
    milliseconds,
    throttle = requestor_array.length
) {

// The 'run' function does the work that is common to all of the parseq
// factories. It takes the name of the factory, an array of requestors, an
// initial value, an action callback, a timeout callback, a time limit in
// milliseconds, and a throttle.

// If all goes well we will be calling all of the requestor functions in the
// array. Each of them  might return a cancel function that will be kept in
// the 'cancel_array'.

    let cancel_array = new Array(requestor_array.length);
    let next_number = 0;
    let timer_id;

// We need 'cancel' and 'start_requestor' functions.

    function cancel(reason = make_error(factory_name, "Cancel.")) {

// Stop all unfinished business. This can be called when a requestor fails.
// It can also be called when a requestor succeeds, such as 'race' stopping
// its losers, or 'parallel' stopping the unfinished optionals.

// If a timer is running, stop it.

        if (timer_id !== undefined) {
            clearTimeout(timer_id);
            timer_id = undefined;
        }

// If anything is still going, cancel it.

        if (cancel_array !== undefined) {
            cancel_array.forEach(function (cancel) {
                try {
                    if (typeof cancel === "function") {
                        return cancel(reason);
                    }
                } catch (ignore) {}
            });
            cancel_array = undefined;
        }
    }

    function start_requestor(value) {

// The 'start_requestor' function is not recursive, exactly. It does not
// directly call itself, but it does return a function that might call
// 'start_requestor'.

// Start the execution of a requestor, if there are any still waiting.

        if (
            cancel_array !== undefined
            && next_number < requestor_array.length
        ) {

// Each requestor has a number.

            let number = next_number;
            next_number += 1;

// Call the next requestor, passing in a callback function,
// saving the cancel function the requestor might return.

            const requestor = requestor_array[number];
            try {
                cancel_array[number] = requestor(
                    function start_requestor_callback(success, error) {

// This callback function is called by the 'requestor' when it is done.
// If we are no longer running, then this call will be ignored.
// For example, it might be a result that is sent back after the time
// limit has expired. This callback function can only be called once.

                        if (
                            cancel_array !== undefined
                            && number !== undefined
                        ) {

// We no longer need the cancel associated with this requestor.

                            cancel_array[number] = undefined;

// Call the 'action' function to let the requestor know what happened.

                            action(success, error, number);

// Clear 'number' so this callback can not be used again.

                            number = undefined;

// If there are any requestors that are still waiting to start, then start the
// next one. If the next requestor is in a sequence, then it will get the most
// recent 'success'. The others get the 'initial_value'.

                            return start_requestor(
                                (factory_name === "sequence")
                                    ? success
                                    : initial_value
                            );
                        }
                    },
                    value
                );

// Requestors are required to report their failure through the callback.
// They are not allowed to throw exceptions. If we happen to catch one,
// it will be treated as a failure.

            } catch (exception) {
                action(undefined, exception, number);
                number = undefined;
                start_requestor(value);
            }
        }
    }

// With the 'cancel' and the 'start_requestor' functions in hand, we can now
// get to work.

// If we are doing 'race' or 'parallel', we want to start all of the requestors
// at once. However, if there is an effective 'throttle' in place then we can
// not start them all. We will start as many as 'throttle' allows, and then as
// each requestor finishes, another will be started.

// The 'sequence' and 'fallback' factories set 'throttle' to 1 because they
// process one at a time and will always start another requestor when the
// previous requestor finishes.

    if (!Number.isSafeInteger(throttle) || throttle < 1) {
        throw make_error(factory_name, "Bad throttle.", throttle);
    }
    let repeat = Math.min(throttle, requestor_array.length);
    while (repeat > 0) {
        setTimeout(start_requestor, 0, initial_value);
        repeat -= 1;
    }

// If a timeout was requested, start the timer.

    if (milliseconds !== undefined) {
        if (typeof milliseconds === "number" && milliseconds >= 0) {
            if (milliseconds > 0) {
                timer_id = setTimeout(timeout, milliseconds);
            }
        } else {
            throw make_error(factory_name, "Bad milliseconds.", milliseconds);
        }
    }

// We return 'cancel' which will allow the requestor to cancel this work.

    return cancel;
}

// The factories: --------------------------------------------------------------

function fallback(requestor_array, milliseconds) {

// The fallback factory will try each requestor in order until it finds a
// successful one.

    check_requestor_array(requestor_array, "fallback");

// The fallback factory returns a requestor. It calls 'run' to manage the
// requestors. The 'fallback_action' function will be called with the result
// from each requestor.

    return function fallback_requestor(callback, initial_value) {
        check_callback(callback, "fallback");
        let number_pending = requestor_array.length;
        let cancel = run(
            "fallback",
            requestor_array,
            initial_value,
            function fallback_action(success, error, ignore) {
                number_pending -= 1;

// If we got a success, then we are done. Cancel any remaining requestors.

                if (success !== undefined) {
                    cancel();
                    callback(success);
                    callback = undefined;
                }

// If we got all of the results without seeing a success,
// then we have a failure.

                if (number_pending < 1) {
                    cancel(error);
                    callback(undefined, error);
                    callback = undefined;
                }
            },
            function fallback_timeout() {
                let error = make_error("fallback", "Timeout.", milliseconds);
                cancel(error);
                callback(undefined, error);
                callback = undefined;
            },
            milliseconds,
            1
        );

// The requestor returns its 'cancel' function.

        return cancel;
    };
}

function parallel(
    required_array,
    optional_array,
    milliseconds,
    throttle,
    option
) {

// The parallel function is the most complex of these factories. It can take an
// second array of requestors that has a more forgiving failure policy.

    let number_required;
    let requestor_array;

// There are four cases because 'required_array' and 'optional_array' can both
// be empty.

    if (required_array === undefined || required_array.length === 0) {
        number_required = 0;
        if (optional_array === undefined || optional_array.length === 0) {

// If both are empty, then there is probably a mistake.

            throw make_error(
                "parallel",
                "Missing requestor array.",
                required_array
            );
        }

// If there is only 'optional_array', then it is the 'requestor_array'.

        requestor_array = optional_array;
        option = true;
    } else {

// If there is only 'required_array', then it is the 'requestors_array'.

        number_required = required_array.length;
        if (optional_array === undefined || optional_array.length === 0) {
            requestor_array = required_array;
            option = undefined;

// If both arrays are provided, we concatenate them together.

        } else {
            requestor_array = required_array.concat(optional_array);
            if (option !== undefined && typeof option !== "boolean") {
                throw make_error("parallel", "Bad option.", option);
            }
        }
    }

// We check the array and return the requestor.

    check_requestor_array(requestor_array, "parallel");
    return function parallel_requestor(callback, initial_value) {
        check_callback(callback, "parallel");
        let number_pending = requestor_array.length;
        let number_pending_required_array = number_required;
        let results = [];

// 'run' gets it started.

        let cancel = run(
            "parallel",
            requestor_array,
            initial_value,
            function parallel_action(success, error, number) {

// The action function gets the result of each requestor in the array.
// 'parallel' wants to return an array of all of the successes it sees.

                results[number] = success;
                number_pending -= 1;

// If the requestor was one of the requireds, make sure it was successful.
// If it failed, then the parallel operation fails. If an optionals requestor
// fails, we can still continue.

                if (number < number_required) {
                    number_pending_required_array -= 1;
                    if (success === undefined) {
                        cancel(error);
                        callback(undefined, error);
                        callback = undefined;
                        return;
                    }
                }

// If all have been processed, or if the requireds have all succeeded and we
// do not have an 'option', then we are done.

                if (
                    number_pending < 1
                    || (
                        option === undefined
                        && number_pending_required_array < 1
                    )
                ) {
                    cancel(make_error("parallel", "Optional."));
                    callback(results);
                    callback = undefined;
                }
            },
            function parallel_timeout() {

// When the timer fires, work stops unless we were under the 'false' option.
// The 'false' option puts no time limits on the requireds, allowing the
// optionals to run until the requireds finish or the the time expires,
// whichever happens last.

                const reason = make_error(
                    "parallel",
                    "Timeout.",
                    milliseconds
                );
                if (option === false) {
                    option = undefined;
                    if (number_pending_required_array < 1) {
                        cancel(reason);
                        callback(results);
                    }
                } else {

// Time has expired. If all of the requireds were successful,
// then the parallel operation is successful.

                    cancel(reason);
                    if (number_pending_required_array < 1) {
                        callback(results);
                    } else {
                        callback(undefined, reason);
                    }
                    callback = undefined;
                }
            },
            milliseconds,
            throttle
        );
        return cancel;
    };
}

function parallel_object(
    required_object,
    optional_object,
    milliseconds,
    throttle,
    option
) {

// 'parallel_object' is similar to 'parallel' except that it takes and produces
// objects of requestors instead of arrays of requestors. It lets 'parallel' do
// most of the work. // This factory converts the objects to arrays and back
// again.

    const names = [];
    let required_array = [];
    let optional_array = [];

// Extract the names and requestors from 'required_object'.
// We only collect functions with an arity of 1 or 2.

    if (required_object !== undefined) {
        if (typeof required_object !== "object") {
            throw make_error(
                "parallel_object",
                "Type mismatch.",
                required_object
            );
        }
        Object.keys(required_object).forEach(function (name) {
            let requestor = required_object[name];
            if (
                typeof requestor === "function"
                && (requestor.length === 1 || requestor.length === 2)
            ) {
                names.push(name);
                required_array.push(requestor);
            }
        });
    }

// Extract the names and requestors from 'optional_object'.
// Look for duplicate keys.

    if (optional_object !== undefined) {
        if (typeof optional_object !== "object") {
            throw make_error(
                "parallel_object",
                "Type mismatch.",
                optional_object
            );
        }
        Object.keys(optional_object).forEach(function (name) {
            let requestor = optional_object[name];
            if (
                typeof requestor === "function"
                && (requestor.length === 1 || requestor.length === 2)
            ) {
                if (
                    required_object !== undefined
                    && required_object[name] !== undefined
                ) {
                    throw make_error(
                        "parallel_object",
                        "Duplicate name.",
                        name
                    );
                }
                names.push(name);
                optional_array.push(requestor);
            }
        });
    }

// Make sure that we harvested something.

    if (names.length === 0) {
        return make_error(
            "parallel_object",
            "No requestors.",
            required_object
        );
    }

// Call parallel to get a requestor.

    const parallel_requestor = parallel(
        required_array,
        optional_array,
        milliseconds,
        throttle,
        option
    );

// Return the parallel object requestor.

    return function parallel_object_requestor(callback, initial_value) {

// When our requestor is called, we return the result of our parallel requestor.

        check_callback(callback, "parallel_object");
        return parallel_requestor(

// We pass our callback to the parallel requestor,
// converting its success into an object.

            function parallel_object_callback(success, error) {
                if (success === undefined) {
                    return callback(success, error);
                }
                const object = Object.create(null);
                names.forEach(function (name, index) {
                    object[name] = success[index];
                });
                return callback(object);
            },
            initial_value
        );
    };
}

function race(requestor_array, milliseconds, throttle) {

// A race starts all of its requestors at once. The first success wins.

    check_requestor_array(requestor_array, "race");
    return function race_requestor(callback, initial_value) {
        check_callback(callback, "race");
        let number_pending = requestor_array.length;
        let cancel = run(
            "race",
            requestor_array,
            initial_value,
            function race_action(success, error, number) {
                number_pending -= 1;

// We have a winner. Cancel the losers and hand the result to the callback.

                if (success !== undefined) {
                    cancel(make_error("race", "Loser.", number));
                    callback(success);
                    callback = undefined;
                }

// There was no winner. Signal a failure.

                if (number_pending < 1) {
                    cancel(error);
                    callback(undefined, error);
                    callback = undefined;
                }
            },
            function race_timeout() {
                let error = make_error("race", "Timeout.", milliseconds);
                cancel(error);
                callback(undefined, error);
                callback = undefined;
            },
            milliseconds,
            throttle
        );
        return cancel;
    };
}

function sequence(requestor_array, milliseconds) {

// A sequence runs each requestor in order, passing results to the next,
// as long as they are all successful.

    check_requestor_array(requestor_array, "sequence");
    return function sequence_requestor(callback, initial_value) {
        check_callback(callback, "sequence");
        let number_pending = requestor_array.length;
        let cancel = run(
            "sequence",
            requestor_array,
            initial_value,
            function sequence_action(success, error, ignore) {
                if (callback !== undefined) {
                    number_pending -= 1;

// If any requestor fails, then the sequence fails.

                    if (success === undefined) {
                        cancel(error);
                        callback(undefined, error);
                        callback = undefined;
                    }

// If we make it to the end, then success.

                    if (number_pending < 1) {
                        cancel();
                        callback(success);
                        callback = undefined;
                    }
                }
            },
            function sequence_timeout() {
                let error = make_error("sequence", "Timeout.", milliseconds);
                cancel(error);
                callback(undefined, error);
                callback = undefined;
            },
            milliseconds,
            1
        );
        return cancel;
    };
}

const parseq = Object.create(null);
parseq.fallback = fallback;
parseq.parallel = parallel;
parseq.parallel_object = parallel_object;
parseq.race = race;
parseq.sequence = sequence;
export default Object.freeze(parseq);
