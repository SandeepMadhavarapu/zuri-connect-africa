import { useAuth } from '@/lib/AuthContext.jsx';

export { useAuth };

export function useSessionUser() {
  const { user, isAuthenticated } = useAuth();
  return { user, isAuthenticated };
}
