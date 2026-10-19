//! Synchronous browser action guard. No private export bytes are stored here.
#[cfg(all(feature = "web", target_arch = "wasm32"))]
mod browser {
    use web_sys::wasm_bindgen;
    use web_sys::wasm_bindgen::{closure::Closure, prelude::*};
    #[wasm_bindgen(
        inline_js = "const guards = globalThis[Symbol.for('orkestr.memory.export.guards')] ??= new Map(); export function installMemoryGuard(id, check) { guards.set(id, check); } export function removeMemoryGuard(id) { guards.delete(id); } export function memoryExportAllowed(id) { return guards.get(id)?.() === true; }"
    )]
    extern "C" {
        fn installMemoryGuard(id: &str, check: &JsValue);
        fn removeMemoryGuard(id: &str);
    }
    pub struct Guard {
        id: String,
        _check: Closure<dyn Fn() -> bool>,
    }
    impl Guard {
        pub fn new(check: impl Fn() -> bool + 'static) -> Self {
            thread_local! { static NEXT: std::cell::Cell<u64> = const { std::cell::Cell::new(0) }; }
            let id = NEXT.with(|next| {
                let value = next.get().checked_add(1).expect("export guard exhausted");
                next.set(value);
                format!("memory-export-{value}")
            });
            let check = Closure::wrap(Box::new(check) as Box<dyn Fn() -> bool>);
            installMemoryGuard(&id, check.as_ref());
            Self { id, _check: check }
        }
        pub fn id(&self) -> &str {
            &self.id
        }
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            removeMemoryGuard(&self.id);
        }
    }
}
#[cfg(all(feature = "web", target_arch = "wasm32"))]
pub use browser::Guard;
