const fs = require('fs')
const os = require('os')
const path = require('path')

jest.mock('@actions/core')
jest.mock('@actions/github', () => ({
  context: { repo: { owner: 'spring-projects', repo: 'spring-security' } },
  getOctokit: jest.fn(),
}))

const core = require('@actions/core')
const github = require('@actions/github')
const {
  run,
  fetchGenerations,
  isActiveGeneration,
  findMilestoneNumber,
  findMainGeneration,
  readProjectVersion,
  toVersionBranch,
  resolveMainMilestone,
} = require('../src/main')

// A representative slice of the spring-security generations API response.
// Dates are fixed so tests remain deterministic regardless of when they run.
const GENERATIONS = [
  {
    name: '6.3.x',
    initialReleaseDate: '2024-05-31',
    ossSupportEndDate: '2025-06-30',
    commercialSupportEndDate: '2026-06-30',
  },
  {
    name: '6.4.x',
    initialReleaseDate: '2024-11-30',
    ossSupportEndDate: '2025-12-31',
    commercialSupportEndDate: '2026-12-31',
  },
  {
    name: '6.5.x',
    initialReleaseDate: '2025-05-31',
    ossSupportEndDate: '2026-06-30',
    commercialSupportEndDate: '2032-06-30',
  },
  {
    name: '7.0.x',
    initialReleaseDate: '2025-11-30',
    ossSupportEndDate: '2026-12-31',
    commercialSupportEndDate: '2027-12-31',
  },
  {
    name: '7.1.x',
    initialReleaseDate: '2026-05-31',
    ossSupportEndDate: '2027-06-30',
    commercialSupportEndDate: '2028-06-30',
  },
]

// Fixed reference date used across all date-sensitive tests.
const TODAY = new Date('2026-03-20T00:00:00Z')

// ---------------------------------------------------------------------------
// isActiveGeneration
// ---------------------------------------------------------------------------

describe('isActiveGeneration', () => {
  describe('oss', () => {
    it('includes a generation within its OSS support window', () => {
      expect(isActiveGeneration(GENERATIONS[2], 'oss', TODAY)).toBe(true)  // 6.5.x
      expect(isActiveGeneration(GENERATIONS[3], 'oss', TODAY)).toBe(true)  // 7.0.x
    })

    it('excludes a generation whose OSS support has ended', () => {
      expect(isActiveGeneration(GENERATIONS[0], 'oss', TODAY)).toBe(false) // 6.3.x ossEnd 2025-06-30
      expect(isActiveGeneration(GENERATIONS[1], 'oss', TODAY)).toBe(false) // 6.4.x ossEnd 2025-12-31
    })

    it('excludes a generation whose initialReleaseDate is in the future', () => {
      expect(isActiveGeneration(GENERATIONS[4], 'oss', TODAY)).toBe(false) // 7.1.x initial 2026-05-31
    })
  })

  describe('commercial', () => {
    it('includes a generation past OSS support but within commercial support', () => {
      expect(isActiveGeneration(GENERATIONS[0], 'commercial', TODAY)).toBe(true) // 6.3.x
      expect(isActiveGeneration(GENERATIONS[1], 'commercial', TODAY)).toBe(true) // 6.4.x
    })

    it('excludes a generation still within its OSS support window', () => {
      expect(isActiveGeneration(GENERATIONS[2], 'commercial', TODAY)).toBe(false) // 6.5.x still in OSS
    })

    it('excludes a generation whose commercial support has also ended', () => {
      const expired = {
        name: '5.8.x',
        initialReleaseDate: '2022-11-30',
        ossSupportEndDate: '2023-12-31',
        commercialSupportEndDate: '2024-06-30',
      }
      expect(isActiveGeneration(expired, 'commercial', TODAY)).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// toVersionBranch
// ---------------------------------------------------------------------------

describe('toVersionBranch', () => {
  it.each([
    ['7.1.2-SNAPSHOT', '7.1.x'],
    ['6.5.0-M1',       '6.5.x'],
    ['6.2.3',          '6.2.x'],
    ['10.0.0-SNAPSHOT','10.0.x'],
  ])('%s → %s', (input, expected) => {
    expect(toVersionBranch(input)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// findMainGeneration
// ---------------------------------------------------------------------------

describe('findMainGeneration', () => {
  it('returns the highest-versioned generation not already a feature branch', () => {
    expect(findMainGeneration(GENERATIONS, ['6.5.x', '7.0.x'])).toBe('7.1.x')
  })

  it('returns the correct candidate when the highest version IS a feature branch', () => {
    expect(findMainGeneration(GENERATIONS, ['6.5.x', '7.0.x', '7.1.x'])).toBe('6.4.x')
  })

  it('returns null when generations is empty', () => {
    expect(findMainGeneration([], ['6.5.x'])).toBeNull()
  })

  it('returns null when every generation is already a feature branch', () => {
    const names = GENERATIONS.map(g => g.name)
    expect(findMainGeneration(GENERATIONS, names)).toBeNull()
  })

  it('returns the highest version when no feature branches exist', () => {
    expect(findMainGeneration(GENERATIONS, [])).toBe('7.1.x')
  })
})

// ---------------------------------------------------------------------------
// findMilestoneNumber
// ---------------------------------------------------------------------------

describe('findMilestoneNumber', () => {
  const milestones = [
    { title: '6.5.x', number: 10 },
    { title: '7.0.x', number: 11 },
    { title: '7.1.x', number: 12 },
  ]

  it('returns the milestone number for an exact title match', () => {
    expect(findMilestoneNumber(milestones, '6.5.x')).toBe(10)
    expect(findMilestoneNumber(milestones, '7.1.x')).toBe(12)
  })

  it('returns undefined when no milestone matches', () => {
    expect(findMilestoneNumber(milestones, '8.0.x')).toBeUndefined()
  })

  it('returns undefined for an empty milestone list', () => {
    expect(findMilestoneNumber([], '6.5.x')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// fetchGenerations
// ---------------------------------------------------------------------------

describe('fetchGenerations', () => {
  afterEach(() => jest.restoreAllMocks())

  it('returns generations on a successful response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ _embedded: { generations: GENERATIONS } }),
    })
    const result = await fetchGenerations('spring-security')
    expect(result).toEqual(GENERATIONS)
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.spring.io/projects/spring-security/generations'
    )
  })

  it('returns an empty array when the project is not found (404)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 })
    await expect(fetchGenerations('unknown-project')).resolves.toEqual([])
  })

  it('throws on unexpected non-404 errors', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 })
    await expect(fetchGenerations('spring-security')).rejects.toThrow('503')
  })

  it('returns an empty array when _embedded is missing from the response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    })
    await expect(fetchGenerations('spring-security')).resolves.toEqual([])
  })
})

// ---------------------------------------------------------------------------
// readProjectVersion
// ---------------------------------------------------------------------------

describe('readProjectVersion', () => {
  afterEach(() => jest.restoreAllMocks())

  it('reads the version from pom.xml', () => {
    jest.spyOn(fs, 'existsSync').mockImplementation(p => p.endsWith('pom.xml'))
    jest.spyOn(fs, 'readFileSync').mockReturnValue(
      '<project><version>6.5.0-SNAPSHOT</version></project>'
    )
    expect(readProjectVersion('/workspace')).toBe('6.5.0-SNAPSHOT')
  })

  it('reads the version from gradle.properties when pom.xml is absent', () => {
    jest.spyOn(fs, 'existsSync').mockImplementation(p => p.endsWith('gradle.properties'))
    jest.spyOn(fs, 'readFileSync').mockReturnValue('group=org.example\nversion=7.1.0-SNAPSHOT\n')
    expect(readProjectVersion('/workspace')).toBe('7.1.0-SNAPSHOT')
  })

  it('prefers pom.xml over gradle.properties when both exist', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true)
    jest.spyOn(fs, 'readFileSync').mockImplementation(p => {
      if (p.endsWith('pom.xml')) return '<project><version>6.5.0-SNAPSHOT</version></project>'
      return 'version=7.1.0-SNAPSHOT\n'
    })
    expect(readProjectVersion('/workspace')).toBe('6.5.0-SNAPSHOT')
  })

  it('returns null when neither build file is present', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false)
    expect(readProjectVersion('/workspace')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resolveMainMilestone
// ---------------------------------------------------------------------------

describe('resolveMainMilestone', () => {
  const milestones = [
    { title: '7.1.x', number: 12 },
  ]

  afterEach(() => jest.restoreAllMocks())

  it('resolves from the API when a matching generation and milestone exist', async () => {
    // 7.1.x is the highest generation not in ['6.5.x', '7.0.x'] and has milestone #12
    const result = await resolveMainMilestone(
      GENERATIONS, ['6.5.x', '7.0.x'], milestones, '/workspace'
    )
    expect(result).toBe(12)
  })

  it('falls back to build files when no API generation has a matching milestone', async () => {
    // No milestone for any API candidate; gradle.properties declares 7.1.0-SNAPSHOT → 7.1.x → #99
    jest.spyOn(fs, 'existsSync').mockImplementation(p => p.endsWith('gradle.properties'))
    jest.spyOn(fs, 'readFileSync').mockReturnValue('version=7.1.0-SNAPSHOT\n')
    const buildMilestones = [{ title: '7.1.x', number: 99 }]

    // Force the API path to find no milestone by passing empty generations so findMainGeneration returns null
    const result = await resolveMainMilestone(
      [], [], buildMilestones, '/workspace'
    )
    expect(result).toBe(99)
  })

  it('returns undefined when no milestone is found by any method', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false)
    const result = await resolveMainMilestone(
      GENERATIONS, ['6.5.x', '7.0.x'], [], '/workspace'
    )
    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// run() — integration tests using a real temporary workspace
// ---------------------------------------------------------------------------

// Minimal spec template used across integration tests. Uses standalone {{#milestone}} tags
// so the milestone line is cleanly omitted (no blank lines) when a milestone is absent.
// {{#milestone}} / {{/milestone}} are each on their own line (standalone tags) so Mustache
// consumes the tag+newline entirely when the section is falsy, leaving no blank lines.
// {{milestone}} is used instead of {{.}} to look up the key by name regardless of how
// Mustache pushes the numeric value onto the context stack.
const SPEC_TEMPLATE = `\
version: 2
updates:
{{#feature-branches}}
  - package-ecosystem: gradle
    {{>target-branch}}
{{#milestone}}
    milestone: {{milestone}}
{{/milestone}}
    {{>directory}}
    {{>schedule}}
    {{>labels}}
{{/feature-branches}}
{{#main}}
  - package-ecosystem: github-actions
    {{>target-branch}}
{{#milestone}}
    milestone: {{milestone}}
{{/milestone}}
    {{>directory}}
    {{>schedule}}
    {{>labels}}
{{/main}}
`

function makeMockOctokit(milestones) {
  return {
    rest: {
      issues: {
        listMilestones: jest.fn().mockResolvedValue({ data: milestones }),
      },
    },
  }
}

describe('run', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-dependabot-test-'))
    fs.mkdirSync(path.join(tmpDir, '.github', 'specs'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.github', 'specs', 'dependabot.spec.yml'), SPEC_TEMPLATE)

    process.env.GITHUB_WORKSPACE = tmpDir
    github.context.repo.owner = 'spring-projects'
    github.context.repo.repo = 'spring-security'

    core.getInput.mockImplementation(name => name === 'token' ? 'test-token' : '')
    global.fetch = jest.fn()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.GITHUB_WORKSPACE
    jest.clearAllMocks()
  })

  it('renders feature branches and main for an OSS project', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ _embedded: { generations: GENERATIONS } }),
    })
    github.getOctokit.mockReturnValue(makeMockOctokit([
      { title: '6.5.x', number: 10 },
      { title: '7.0.x', number: 11 },
      { title: '7.1.x', number: 12 },
    ]))

    await run()

    const output = fs.readFileSync(path.join(tmpDir, '.github', 'dependabot.yml'), 'utf8')
    expect(output).toContain('target-branch: 6.5.x')
    expect(output).toContain('milestone: 10')
    expect(output).toContain('target-branch: 7.0.x')
    expect(output).toContain('milestone: 11')
    expect(output).toContain('target-branch: main')
    expect(output).toContain('milestone: 12')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('omits the milestone line when no matching milestone exists for a branch', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ _embedded: { generations: GENERATIONS } }),
    })
    // Only a milestone for 6.5.x; 7.0.x and main (7.1.x) have none
    github.getOctokit.mockReturnValue(makeMockOctokit([
      { title: '6.5.x', number: 10 },
    ]))

    await run()

    const output = fs.readFileSync(path.join(tmpDir, '.github', 'dependabot.yml'), 'utf8')
    expect(output).toContain('target-branch: 6.5.x')
    expect(output).toContain('milestone: 10')
    expect(output).toContain('target-branch: 7.0.x')
    // No blank milestone line for 7.0.x or main
    const lines = output.split('\n')
    const milestoneLine = lines.find(l => l.trim().startsWith('milestone:'))
    expect(milestoneLine).toBe('    milestone: 10')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('renders only commercial feature branches and omits the main section', async () => {
    github.context.repo.repo = 'spring-security-commercial'
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ _embedded: { generations: GENERATIONS } }),
    })
    github.getOctokit.mockReturnValue(makeMockOctokit([
      { title: '6.3.x', number: 5 },
      { title: '6.4.x', number: 6 },
    ]))

    await run()

    const output = fs.readFileSync(path.join(tmpDir, '.github', 'dependabot.yml'), 'utf8')
    expect(output).toContain('target-branch: 6.3.x')
    expect(output).toContain('milestone: 5')
    expect(output).toContain('target-branch: 6.4.x')
    expect(output).toContain('milestone: 6')
    expect(output).not.toContain('target-branch: main')
    expect(output).not.toContain('target-branch: 6.5.x') // still in OSS, not commercial
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('renders only the main section when the project is not in the Spring API', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 404 })
    github.getOctokit.mockReturnValue(makeMockOctokit([]))

    await run()

    const output = fs.readFileSync(path.join(tmpDir, '.github', 'dependabot.yml'), 'utf8')
    expect(output).toContain('target-branch: main')
    expect(output).not.toContain('target-branch: 6.5.x')
    expect(output).not.toContain('milestone:')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('calls setFailed when the spec file is missing', async () => {
    fs.rmSync(path.join(tmpDir, '.github', 'specs', 'dependabot.spec.yml'))
    global.fetch.mockResolvedValue({ ok: false, status: 404 })
    github.getOctokit.mockReturnValue(makeMockOctokit([]))

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Spec template not found')
    )
  })
})
