use objc2_foundation::{NSBundle, NSLocale};

pub(super) fn preferred_language() -> Option<String> {
    NSBundle::mainBundle()
        .preferredLocalizations()
        .firstObject()
        .or_else(|| NSLocale::preferredLanguages().firstObject())
        .map(|language| language.to_string())
}
