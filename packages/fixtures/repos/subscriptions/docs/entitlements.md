# Entitlements

## How premium access is checked

Premium features never read the subscription record directly. `hasPremiumAccess` checks the
entitlements cached on the caller's session, which `createSession` loads at sign-in.

## Downgrades take effect within one hour

Support promises customers, and finance reconciles against it, that a downgrade removes premium
features within one hour. Sessions therefore cache entitlements for at most 60 minutes. Any other
cache of entitlements must expire within the same hour, or be cleared by `downgradeSubscription`.
