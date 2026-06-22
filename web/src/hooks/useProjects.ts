// useProjects — the projects list + CRUD mutations from /v1/projects (contract
// C-F8). Reads are gated on a key (useHasReadKey); each mutation invalidates the
// ['projects'] list so the UI reflects a create/update/delete without a manual
// refetch.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { getProjects, createProject, updateProject, deleteProject } from '@/lib/api'
import type { ProjectsResponse } from '@/lib/types'
import { useHasReadKey } from './_shared'

export function useProjects() {
  const hasReadKey = useHasReadKey()
  const qc = useQueryClient()
  const query = useQuery<ProjectsResponse>({
    queryKey: ['projects'],
    queryFn: () => getProjects(),
    enabled: hasReadKey,
  })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['projects'] })
  const create = useMutation({ mutationFn: createProject, onSuccess: invalidate })
  const update = useMutation({ mutationFn: updateProject, onSuccess: invalidate })
  const remove = useMutation({ mutationFn: deleteProject, onSuccess: invalidate })
  return { query, create, update, remove }
}
