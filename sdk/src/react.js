// React error boundary. Takes the client explicitly so this module has no
// import cycle with index.js. React is an optional peer dependency.

import { Component } from "react";

export function createErrorBoundary(client, options = {}) {
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
      client.captureException(error, {
        $handled: true,
        $mechanism: "react-error-boundary",
        $react_stack: info?.componentStack,
      });
      if (typeof this.props.onError === "function") {
        this.props.onError(error, info);
      }
    }

    render() {
      if (this.state.hasError) {
        const fb = this.props.fallback ?? fallback;
        return typeof fb === "function" ? fb() : fb;
      }
      return this.props.children;
    }
  };
}
