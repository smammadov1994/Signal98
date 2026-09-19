// React error boundary. React is an optional peer dependency, which is why
// this lives behind its own entry point ("signal98/react").
//
//   const Boundary = createErrorBoundary();            // uses the init() client
//   const Boundary = createErrorBoundary(getClient()); // v0.1 style, still fine

import { Component } from "react";
import { resolveClient } from "./hub.js";

export function createErrorBoundary(client, options = {}) {
  // createErrorBoundary({ fallback }) — options only.
  if (client && typeof client.captureException !== "function") {
    options = client;
    client = null;
  }
  const { fallback = null } = options;

  return class SignalBoundary extends Component {
    constructor(props) {
      super(props);
      this.state = { hasError: false };
    }

    static getDerivedStateFromError() {
      return { hasError: true };
    }

    componentDidCatch(error, info) {
      try {
        // Resolved at catch time, so a boundary created before init() still reports.
        const c = resolveClient(client);
        if (c) {
          c.captureException(error, {
            $handled: true,
            $mechanism: "react-error-boundary",
            $react_stack: info && info.componentStack,
          });
        }
      } catch {
        /* reporting must not break the fallback UI */
      }
      if (typeof this.props.onError === "function") {
        this.props.onError(error, info);
      }
    }

    render() {
      if (this.state.hasError) {
        const fb = this.props.fallback != null ? this.props.fallback : fallback;
        return typeof fb === "function" ? fb() : fb;
      }
      return this.props.children;
    }
  };
}
