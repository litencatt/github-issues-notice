/**
 * GitHub issues notice
 *
 * Copyright (c) 2018 Tomohisa Oda
 */

import { Github, Issue, PullRequest } from './github'
import { Slack, Attachment } from './slack'

/**
 * GithubIssuesNotice
 */
export class GithubIssuesNotice {
  private get slack(): Slack {
    if (this.pSlack === undefined) {
      this.pSlack = new Slack(this.config.slack.token)
    }

    return this.pSlack
  }

  private get github(): Github {
    if (this.pGithub === undefined) {
      if (this.config.github.apiEndpoint) {
        this.pGithub = new Github(
          this.config.github.token,
          this.config.github.apiEndpoint
        )
      } else {
        this.pGithub = new Github(this.config.github.token)
      }
    }

    return this.pGithub
  }

  private get sheet(): GoogleAppsScript.Spreadsheet.Sheet {
    if (this.pSheet === undefined) {
      const s = SpreadsheetApp.openById(this.config.spreadsheets.id)
      this.pSheet = s.getSheetByName('config')
    }

    return this.pSheet
  }

  private get reportSheet(): GoogleAppsScript.Spreadsheet.Sheet {
    if (this.pReportSheet === undefined) {
      const s = SpreadsheetApp.openById(this.config.spreadsheets.id)
      this.pReportSheet = s.getSheetByName('report')
    }

    return this.pReportSheet
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get data(): any[][] {
    if (this.pData === undefined) {
      const startRow = 2
      const startColumn = 1
      const numRow = this.sheet.getLastRow()
      const numColumn = this.sheet.getLastColumn()
      this.pData = this.sheet.getSheetValues(
        startRow,
        startColumn,
        numRow,
        numColumn
      )
    }

    return this.pData
  }

  public config: Config
  private pSheet: GoogleAppsScript.Spreadsheet.Sheet
  private pReportSheet: GoogleAppsScript.Spreadsheet.Sheet
  private pSlack: Slack
  private pGithub: Github
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pData: any[][]

  constructor(c: Config) {
    this.config = c
  }

  public static IS_HOLIDAY(date: Date): boolean {
    const startWeek = 0
    const endWeek = 6
    const weekInt = date.getDay()
    if (weekInt <= startWeek || endWeek <= weekInt) {
      return true
    }
    const calendarId = 'ja.japanese#holiday@group.v.calendar.google.com'
    const calendar = CalendarApp.getCalendarById(calendarId)
    const events = calendar.getEventsForDay(date)

    return events.length > 0
  }

  public static CAPITALIZE(word: string): string {
    if (!word) {
      return word
    }

    return word.replace(/\w\S*/g, t => {
      return `${t.charAt(0).toUpperCase()}${t.substr(1).toLowerCase()}`
    })
  }

  public static NORMALIZE(str: string): string[] {
    const arr = str.split('\n')
    for (let v of arr) {
      v = v.trim()
    }

    return arr.filter(v => v)
  }

  private static statsEmoji(r: number): string {
    const danger = 90
    const caution = 80
    const ng = 70
    const warn = 60
    const ok = 50
    const good = 40
    const great = 30

    switch (true) {
      case r > danger:
        return ':skull:'
      case r > caution:
        return ':fire:'
      case r > ng:
        return ':jack_o_lantern:'
      case r > warn:
        return ':space_invader:'
      case r > ok:
        return ':surfer:'
      case r > good:
        return ':palm_tree:'
      case r > great:
        return ':helicopter:'
      default:
        return ':rocket:'
    }
  }

  private static buildStatsAttachment(task: Task): Attachment {
    const p = task.stats.pulls
    const i = task.stats.issues
    const a = task.stats.proactive
    const hundred = 100
    const r = hundred - Math.floor((a / (a + (i - a))) * hundred)
    const url =
      'https://github.com/linyows/github-issues-notice/blob/master/docs/reactive-per.md'
    const m =
      '--% :point_right: Please applying `proactive` label to voluntary issues'
    const info = r === hundred ? m : `${GithubIssuesNotice.statsEmoji(r)} ${r}%`

    return {
      title: `Stats for ${task.repos.length} repositories`,
      color: '#000000',
      text: '',
      footer: `Stats | <${url}|What is this?>`,
      footer_icon: 'https://octodex.github.com/images/surftocat.png',
      fields: [
        { title: 'Reactive Per', value: `${info}`, short: false },
        { title: 'Open Issues Total', value: `${i - p}`, short: true },
        { title: 'Open Pulls Total', value: `${p}`, short: true },
      ],
    }
  }

  public doJob(): void {
    if (GithubIssuesNotice.IS_HOLIDAY(this.config.now)) {
      // debug
      //return
    }

    const job = this.getJobByMatchedTime()
    for (const t of job) {
      this.doTask(t)
    }
  }

  private tidyUpIssues(repo: string, task: Task) {
    const oneD = 24
    const oneH = 3600
    const oneS = 1000
    const now = new Date()
    const period = now.getTime() - task.idle.period * oneD * oneH * oneS
    const displayRepo = task.showOrg ? repo : repo.split('/').pop()

    try {
      const issues = this.github.issues(repo, {
        sort: 'asc',
        direction: 'updated',
      })
      for (const i of issues) {
        if (Date.parse(i.updated_at) > period) {
          continue
        }
        this.github.closeIssue(repo, i.number)
        task.idle.issueTitles.push(
          `<${i.html_url}|${i.title}> (${displayRepo}) by ${i.user.login}`
        )
      }
    } catch (e) {
      console.error(e)
    }
  }

  private doTask(task: Task) {
    for (const repo of task.repos) {
      if (repo === '') {
        continue
      }

      if (task.idle.period > 0) {
        this.tidyUpIssues(repo, task)
      }

      for (const l of task.labels) {
        try {
          const labels = l.name
          const state = task.labelProtection ? 'all' : 'open'
          const issues = this.github.issues(repo, { labels, state })
          for (const i of issues) {
            if (Github.IsPullRequestIssue(i)) {
              continue
            }

            // 昨日以前に作成されたissueはskip
            const ts = Date.parse(i.created_at)
            const now = new Date();
            const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
            if (ts < yesterday.getTime()) {
              continue
            }

            const created_at = new Date(ts)
            const service = ""
            const category = ""
            const requesting_team = ""
            const processing_time = ""
            const product = ""
            let assignee = ""
            if (i.assignee !== null) {
              assignee = i.assignee.login
            }
            l.issueTitles.push(
              [
                created_at.toLocaleDateString(),
                service,
                i.html_url,
                category,
                requesting_team,
                processing_time,
                product,
                assignee
              ]
            )
          }
        } catch (e) {
          console.error(e)
        }
      }
    }
    // debug
    this.report(task)
  }

  private buildIssueRelations(i: Issue): string {
    if (i.assignees.length == 0) {
      return ''
    }
    return ` (Assignees: ${i.assignees
      .map(u => {
        return u.login
      })
      .join(', ')})`
  }

  private buildPullRelations(i: PullRequest): string {
    if (i.assignees.length == 0 && i.requested_reviewers.length == 0) {
      return ''
    }
    const r = []
    if (i.assignees.length > 0) {
      r.push(
        'Assignees: ' +
          i.assignees
            .map(u => {
              return u.login
            })
            .join(', ')
      )
    }
    if (i.requested_reviewers.length > 0) {
      r.push(
        'Reviewers: ' +
          i.requested_reviewers
            .map(u => {
              return u.login
            })
            .join(', ')
      )
    }
    return ` (${r.join(', ')})`
  }

  private getTsIfDuplicated(channel: string): string {
    const msgs = this.slack.channelsHistory({ channel, count: 1 })
    const msg = msgs[0]

    return msg.username === this.config.slack.username &&
      msg.text.indexOf(this.config.slack.textEmpty) !== -1
      ? msg.ts
      : ''
  }

  private postMessageOrUpdate(channel: string) {
    const ts = this.getTsIfDuplicated(channel)
    if (ts === '') {
      this.slack.postMessage({
        channel,
        username: this.config.slack.username,
        icon_emoji: ':octocat:',
        link_names: 1,
        text: `${this.config.slack.textEmpty}${this.config.slack.textSuffix}`,
      })
    } else {
      const updatedAt = ` -- :hourglass: last updated at: ${this.config.now}`
      this.slack.chatUpdate({
        channel,
        text: `${this.config.slack.textEmpty}${this.config.slack.textSuffix}${updatedAt}`,
        ts: ts,
      })
    }
  }

  // todo:
  // - 日付のJST変換
  // - 重複登録回避
  //   取得したissueがreportシートに重複して登録されないように取得タイミングを1日1回などにし
  //   前日に作成されたissueをまとめて記録されるようにする
  //   または前回実行時から今までに作成されたissueのみを記録するようにする
  // - サービス名などはラベル名から動的に設定
  private report(task: Task) {
    for (const l of task.labels) {
      // 最終行を取得
      const startColumn = "A";
      const endColumn   = "H";
      const lastRow = this.reportSheet.getLastRow();
      const nextRowStart = lastRow + 1;
      const nextRowEnd   = lastRow + l.issueTitles.length;
      const setRange = `${startColumn}${nextRowStart}:${endColumn}${nextRowEnd}`;

      // issue情報の書き込み
      this.reportSheet.getRange(setRange).setValues(l.issueTitles);
    }
  }

  private notify(task: Task) {
    const attachments = []
    const mention = ` ${task.mentions.join(' ')} `
    let empty = true

    if (task.stats.enabled) {
      attachments.push(GithubIssuesNotice.buildStatsAttachment(task))
    }

    for (const l of task.labels) {
      if (l.issueTitles.length === 0) {
        continue
      }
      const h = l.name.replace(/-/g, ' ')
      const m =
        l.issueTitles.length > l.threshold
          ? `${l.name.length > 0 ? ' -- ' : ''}${l.message}`
          : ''
      empty = false
      attachments.push({
        title: `${
          h.toUpperCase() === h ? h : GithubIssuesNotice.CAPITALIZE(h)
        }${m}`,
        color: l.color,
        text: l.issueTitles.join('\n'),
      })
    }

    if (task.idle.issueTitles.length > 0) {
      const url =
        'https://github.com/linyows/github-issues-notice/blob/master/docs/idle-period.md'
      empty = false
      attachments.push({
        title: `Closed with no change over ${task.idle.period}days`,
        color: '#CCCCCC',
        text: task.idle.issueTitles.join('\n'),
        footer: `Idle Period | <${url}|What is this?>`,
        footer_icon:
          'https://octodex.github.com/images/Sentrytocat_octodex.jpg',
        fields: [
          {
            title: 'Closed Total',
            value: `${task.idle.issueTitles.length}`,
            short: true,
          },
        ],
      })
    }

    const messages = []
    if (!empty) {
      messages.push(this.config.slack.textDefault)
    }

    for (const channel of task.channels) {
      try {
        if (empty) {
          this.postMessageOrUpdate(channel)
        } else {
          this.slack.postMessage({
            channel,
            username: this.config.slack.username,
            icon_emoji: ':octocat:',
            link_names: 1,
            text: `${mention}${messages.join(' ')}${
              this.config.slack.textSuffix
            }`,
            attachments: JSON.stringify(attachments),
          })
        }
      } catch (e) {
        console.error(e)
      }
    }
  }

  private getJobByMatchedTime(): Task[] {
    const enabledColumn = 0
    const channelColumn = 1
    const timeColumn = 2
    const mentionColumn = 3
    const repoColumn = 4
    const labelColumn = 5
    const statsColumn = 6
    const idleColumn = 7
    const relationsColumn = 8
    const onlyPullsColumn = 9
    const labelProtectionColumn = 10
    const showOrgColumn = 11

    const nameField = 0
    const thresholdField = 1
    const messageField = 2

    const job: Task[] = []
    const timeLength = 2
    const timeFullLength = 4
    const minStart = 2
    const nowH = `0${this.config.now.getHours()}`.slice(-timeLength)
    const nowM = `00${this.config.now.getMinutes()}`.slice(-timeLength)

    for (const task of this.data) {
      const repos = GithubIssuesNotice.NORMALIZE(`${task[repoColumn]}`)
      if (repos.length === 0) {
        continue
      }

      const enabled = task[enabledColumn]
      if (typeof enabled === 'boolean') {
        if (!enabled) {
          continue
        }
      } else {
        console.error(`"enabled" columns must be of type boolean: ${enabled}`)
      }

      const channels = GithubIssuesNotice.NORMALIZE(`${task[channelColumn]}`)
      const times = GithubIssuesNotice.NORMALIZE(`${task[timeColumn]}`)
      const mentions = GithubIssuesNotice.NORMALIZE(`${task[mentionColumn]}`)
      const labelsWithInfo = GithubIssuesNotice.NORMALIZE(
        `${task[labelColumn]}`
      )

      let relations = task[relationsColumn]
      if (typeof relations !== 'boolean') {
        relations = false
      }
      let onlyPulls = task[onlyPullsColumn]
      if (typeof onlyPulls !== 'boolean') {
        onlyPulls = false
      }
      let labelProtection = task[labelProtectionColumn]
      if (typeof labelProtection !== 'boolean') {
        labelProtection = false
      }
      let showOrg = task[showOrgColumn]
      if (typeof showOrg !== 'boolean') {
        showOrg = false
      }

      let s = task[statsColumn]
      if (typeof s !== 'boolean') {
        s = false
      }
      const stats: Stats = {
        enabled: s,
        issues: 0,
        pulls: 0,
        proactive: 0,
      }

      let idlePeriod = task[idleColumn]
      if (typeof idlePeriod !== 'number') {
        idlePeriod = 0
      }
      const idle: Idle = {
        period: idlePeriod,
        issueTitles: [],
      }

      for (const time of times) {
        const hour = time.substr(0, timeLength)
        const min =
          time.length === timeFullLength
            ? time.substr(minStart, timeLength)
            : '00'

        // debug
        if (true) {
          const labels: Label[] = []
          for (const l of labelsWithInfo) {
            const arr = `${l}`.split('/')
            labels.push({
              name: arr[nameField],
              threshold: +arr[thresholdField],
              message: arr[messageField],
              color: '',
              issueTitles: [],
            })
          }
          job.push({
            channels,
            times,
            mentions,
            repos,
            labels,
            stats,
            idle,
            relations,
            onlyPulls,
            labelProtection,
            showOrg,
          })
        }
      }
    }

    return job
  }
}

type GithubConfig = {
  token: string
  apiEndpoint?: string
}

type SlackConfig = {
  token: string
  username: string
  textSuffix: string
  textEmpty: string
  textDefault: string
}

type SpreadsheetsConfig = {
  id: string
  url: string
}

type Config = {
  now: Date
  slack: SlackConfig
  github: GithubConfig
  spreadsheets: SpreadsheetsConfig
}

type Task = {
  channels: string[]
  times: string[]
  mentions: string[]
  repos: string[]
  labels: Label[]
  stats: Stats
  idle: Idle
  relations: boolean
  onlyPulls: boolean
  labelProtection: boolean
  showOrg: boolean
}

type Idle = {
  period: number
  issueTitles: string[]
}

type Stats = {
  enabled: boolean
  issues: number
  pulls: number
  proactive: number
}

type Label = {
  name: string
  threshold: number
  message: string
  color: string
  issueTitles: string[]
}
