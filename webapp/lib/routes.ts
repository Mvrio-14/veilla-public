/**
 * Entry points into the product, and the contract between them.
 *
 * Signing in and signing up are the same action: `signInWithOtp` with
 * `shouldCreateUser` emails a link that creates the identity when the
 * address is unknown and signs the person in when it is not. One route
 * therefore serves both, and `intent` only decides which words the page
 * uses to describe what is about to happen.
 *
 * The parameter name and the links that carry it live together here
 * because they are two halves of one agreement. Spelled out at each call
 * site instead, a rename would leave the landing sending `?intent=signup`
 * to a page that had moved on to reading something else — and the failure
 * is silent: the form still works, it just greets a new visitor as a
 * returning one.
 */

/** Query parameter carrying why the visitor is on /login. */
export const INTENT_PARAM = "intent";

/** The only value that changes anything. Anything else reads as sign-in. */
export const INTENT_SIGN_UP = "signup";

/** For someone who already has an account. */
export const SIGN_IN_HREF = "/login";

/** For someone arriving from a "try it" call to action. */
export const SIGN_UP_HREF = `/login?${INTENT_PARAM}=${INTENT_SIGN_UP}`;
