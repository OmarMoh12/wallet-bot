'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { useApp } from '@/providers/AppProvider';

/**
 * Minimal data fetching.
 *
 * A hand-rolled hook rather than SWR or React Query. The app has a handful of screens, each
 * loading one or two endpoints, and manual refresh after a mutation is entirely adequate —
 * a caching library would be more code shipped to a mobile WebView than the code it saves.
 *
 * What it does provide: request cancellation on unmount, a stale-result guard so a slow
 * response cannot overwrite a newer one, and an error object the UI can translate.
 */

export interface QueryState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** True while refetching with data already on screen — drives a subtle indicator only. */
  refreshing: boolean;
  refetch: () => Promise<void>;
  setData: (value: T | null) => void;
}

export function useApiQuery<T>(
  path: string | null,
  query?: Record<string, string | number | boolean | undefined>,
): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [refreshing, setRefreshing] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);
  const queryKey = JSON.stringify(query ?? {});

  const run = useCallback(
    async (isRefresh: boolean) => {
      if (!path) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      requestRef.current += 1;
      const requestId = requestRef.current;

      if (isRefresh) setRefreshing(true);
      else setLoading(true);

      try {
        const result = await api.get<T>(path, query, controller.signal);
        // Ignore a response that has been superseded by a newer request.
        if (requestId !== requestRef.current) return;
        setData(result);
        setError(null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        if (requestId !== requestRef.current) return;
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError({ code: 'INTERNAL_ERROR', status: 500 }),
        );
      } finally {
        if (requestId === requestRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    // `queryKey` is the serialised form of `query`, which is a fresh object identity on
    // every render; depending on it directly would re-fetch in a loop.
    [path, queryKey],
  );

  useEffect(() => {
    void run(false);
    return () => abortRef.current?.abort();
  }, [run]);

  const refetch = useCallback(() => run(true), [run]);

  return { data, error, loading, refreshing, refetch, setData };
}

/**
 * Mutation helper.
 *
 * Surfaces the API error code as a localized toast, so no screen has to reimplement error
 * presentation, and internal details never end up in the UI.
 */
export function useMutation<TInput, TResult>(
  perform: (input: TInput) => Promise<TResult>,
  options: { onSuccess?: (result: TResult) => void; successMessage?: string } = {},
) {
  const { t, toast } = useApp();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const mutate = useCallback(
    async (input: TInput): Promise<TResult | null> => {
      setPending(true);
      setError(null);
      try {
        const result = await perform(input);
        if (options.successMessage) toast(options.successMessage, 'success');
        options.onSuccess?.(result);
        return result;
      } catch (caught) {
        const apiError =
          caught instanceof ApiError
            ? caught
            : new ApiError({ code: 'INTERNAL_ERROR', status: 500 });
        setError(apiError);
        // `messageKey` resolves to a translated, user-safe string; the raw code never shows.
        toast(t(apiError.messageKey), 'error');
        return null;
      } finally {
        setPending(false);
      }
    },
    [perform, options.successMessage, t, toast],
  );

  return { mutate, pending, error };
}
