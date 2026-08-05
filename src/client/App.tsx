import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate, Route, Routes } from 'react-router'

import { api } from './api.ts'
import type { GateState } from './api.ts'
import { Gate } from './Gate.tsx'
import { Corpus } from './pages/Corpus.tsx'
import { Overview } from './pages/Overview.tsx'
import { Search } from './pages/Search.tsx'
import { Sessions } from './pages/Sessions.tsx'
import { UnderlayPage } from './pages/Underlay.tsx'
import { Transcript } from './pages/Transcript.tsx'
import { Sidebar } from './Sidebar.tsx'
import { Spinner } from './ui.tsx'

export function App() {
  const queryClient = useQueryClient()
  const gate = useQuery({ queryKey: ['gate'], queryFn: () => api.get<GateState>('/api/gate') })

  if (!gate.data) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <Spinner label="Loading…" />
      </div>
    )
  }

  if (!gate.data.unlocked) {
    return <Gate configured={gate.data.configured} onUnlock={() => queryClient.invalidateQueries()} />
  }

  return (
    <div className="flex min-h-full">
      <Sidebar />
      <main className="scroll-thin min-w-0 flex-1 overflow-x-hidden px-4 py-4 lg:px-6">
        <div className="mx-auto max-w-[78rem]">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/corpus" element={<Corpus />} />
            <Route path="/sessions" element={<Sessions />} />
            <Route path="/sessions/:id" element={<Transcript />} />
            <Route path="/search" element={<Search />} />
            <Route path="/underlay" element={<UnderlayPage />} />
            {/* The page used to be called Team; keep old links working. */}
            <Route path="/team" element={<Navigate to="/underlay" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  )
}
