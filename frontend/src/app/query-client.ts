import { QueryClient } from "@tanstack/react-query";

/** 全局查询缓存；页面状态只缓存后端事实，不作为项目进度来源。 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});
