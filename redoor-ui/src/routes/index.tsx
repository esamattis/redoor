import { createFileRoute, useRouter } from '@tanstack/react-router'
import type { AgentListResponse } from '../../../bindings/AgentListResponse'

export const Route = createFileRoute('/')({
  loader: async ({ context }) => {
    const { agents } = context;
    if (agents.length === 0) {
      return null
    }
    return agents[0]?.id ?? null
  },
  component: Index,
})

function Index() {
  const agentId = Route.useLoaderData()

  if (!agentId) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-gray-500">No agents available</p>
        </div>
      </div>
    )
  }

  const navigate = useRouter().navigate
  navigate({ to: '/agents/$agentId', params: { agentId } })

  return null
}
