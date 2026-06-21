import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ProjectSwitcher } from '@/components/ProjectSwitcher'

test('renders All projects plus one option per project', () => {
  render(<ProjectSwitcher projects={[{slug:'a',name:'A',apps:[]},{slug:'b',name:'B',apps:[]}]} value={undefined} onChange={() => {}} onManage={() => {}} />)
  expect(screen.getByRole('option', { name: 'All projects' })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'A' })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'B' })).toBeInTheDocument()
})

test('selecting a project emits its slug', async () => {
  const onChange = vi.fn()
  render(<ProjectSwitcher projects={[{slug:'a',name:'A',apps:[]}]} value={undefined} onChange={onChange} onManage={() => {}} />)
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Project' }), 'a')
  expect(onChange).toHaveBeenCalledWith('a')
})

test('Manage button fires onManage', async () => {
  const onManage = vi.fn()
  render(<ProjectSwitcher projects={[]} value={undefined} onChange={() => {}} onManage={onManage} />)
  await userEvent.click(screen.getByRole('button', { name: 'Manage projects' }))
  expect(onManage).toHaveBeenCalled()
})
