import type { ComponentType, ErrorInfo, ReactNode } from "react";
import type { Client } from "./index";

export interface BoundaryProps {
  children?: ReactNode;
  fallback?: ReactNode | (() => ReactNode);
  onError?: (error: Error, info: ErrorInfo) => void;
}

export function createErrorBoundary(client: Client, options?: { fallback?: ReactNode | (() => ReactNode) }): ComponentType<BoundaryProps>;
