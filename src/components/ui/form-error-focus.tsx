"use client";

import { useEffect } from "react";

/**
 * After a form is submitted and comes back with field errors, move focus to the
 * first invalid field so keyboard and screen-reader users land on the problem.
 * Mounted once in the workspace layout; every form that marks fields with
 * `aria-invalid` (all TextField/SelectField/TextAreaField errors do) benefits,
 * and no form needs its own effect.
 */
export function FormErrorFocus() {
  useEffect(() => {
    let submitted: HTMLFormElement | null = null;
    let expires = 0;
    let frame = 0;

    const onSubmit = (event: Event) => {
      if (event.target instanceof HTMLFormElement) {
        submitted = event.target;
        expires = performance.now() + 8000;
      }
    };

    const check = () => {
      frame = 0;
      if (!submitted || performance.now() > expires || !submitted.isConnected) {
        submitted = null;
        return;
      }
      const invalid = submitted.querySelector<HTMLElement>("[aria-invalid='true']");
      if (invalid) {
        invalid.focus({ preventScroll: false });
        submitted = null;
      }
    };

    const observer = new MutationObserver(() => {
      if (submitted && !frame) frame = window.requestAnimationFrame(check);
    });
    document.addEventListener("submit", onSubmit, true);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-invalid"],
    });
    return () => {
      document.removeEventListener("submit", onSubmit, true);
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);
  return null;
}
