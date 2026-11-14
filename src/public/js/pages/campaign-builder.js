import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { hourLabel, windowSentence } from '../campaign-utils.js';
import { formatNumber } from '../format.js';
import { state } from '../state.js';
import { campaignBadge } from '../ui/badge.js';
import { selectField, showErrors, textField, textareaField, withBusy } from '../ui/form.js';
import { confirmDialog, openModal } from '../ui/modal.js';
import { emptyState } from '../ui/states.js';
import { toast, toastError } from '../ui/toast.js';

const STEPS = [
  ['audience', 'Audience', 'Who receives it'],
  ['sequence', 'Sequence', 'What you send'],
  ['schedule', 'Schedule', 'When it goes out'],
  ['review', 'Review', 'Check and launch'],
];
const MERGE = ['first_name', 'last_name', 'company', 'email'];
const MAX_STEPS = 10;

export async function campaignBuilderPage({ container, params, query, navigate, isCurrent }) {
  const [{ data: initial }, { data: lists }] = await Promise.all([
    api.get(`/campaigns/${params.id}`),
    api.get('/lists'),
  ]);
  if (!isCurrent()) return;
  if (initial.status !== 'draft') return navigate(`/campaigns/${initial.id}`, { replace: true });

  let campaign = initial;
  let current = Math.max(
    0,
    STEPS.findIndex(([key]) => key === query.get('step')),
  );
  let steps = campaign.steps.length
    ? campaign.steps.map(({ subject, body, delayDays }) => ({ subject, body, delayDays }))
    : [{ subject: '', body: '', delayDays: 0 }];
  let draft = {
    name: campaign.name,
    listId: campaign.listId,
    startMode: campaign.startAt ? 'later' : 'now',
    startAt: campaign.startAt,
    windowStartHour: campaign.windowStartHour,
    windowEndHour: campaign.windowEndHour,
    weekdaysOnly: campaign.weekdaysOnly,
  };
  let reading = () => {};
  const timezone = state.workspace.timezone;

  const body = h('div');

  async function persist() {
    reading();
    if (current === 0) {
      const { data } = await api.patch(`/campaigns/${campaign.id}`, {
        version: campaign.version,
        name: draft.name,
        listId: draft.listId,
      });
      campaign = data;
    } else if (current === 1) {
      const { data } = await api.put(`/campaigns/${campaign.id}/steps`, {
        version: campaign.version,
        steps,
      });
      campaign = data;
    } else if (current === 2) {
      const startAt =
        draft.startMode === 'later' && draft.startAt ? new Date(draft.startAt).toISOString() : null;
      const { data } = await api.patch(`/campaigns/${campaign.id}`, {
        version: campaign.version,
        startAt,
        windowStartHour: draft.windowStartHour,
        windowEndHour: draft.windowEndHour,
        weekdaysOnly: draft.weekdaysOnly,
      });
      campaign = data;
    }
  }

  async function go(index, { quiet = false } = {}) {
    if (index === current) return;
    const form = body.querySelector('form');
    try {
      if (index > current || current < 3) await persist();
    } catch (error) {
      if (error.code === 'VERSION_CONFLICT') {
        toast('This campaign changed in another tab. Reloading it.', { tone: 'info' });
        return void navigate(`/campaigns/${campaign.id}/edit`, { replace: true });
      }
      if (form) showErrors(form, error);
      else toastError(error);
      return;
    }
    current = index;
    window.history.replaceState(
      null,
      '',
      `/campaigns/${campaign.id}/edit?step=${STEPS[current][0]}`,
    );
    draw();
    if (!quiet) window.scrollTo({ top: 0 });
  }

  const header = h('div');
  const stepper = h('ol', { class: 'stepper', 'aria-label': 'Campaign steps' });

  function drawChrome() {
    mount(
      header,
      h('a', { class: 'crumb', href: '/campaigns' }, icon('arrow-left'), 'All campaigns'),
      h(
        'div',
        { class: 'page-header' },
        h(
          'div',
          null,
          h('div', { class: 'row' }, h('h1', null, campaign.name), campaignBadge('draft')),
          h('p', null, 'Changes save as you move between steps.'),
        ),
      ),
    );
    mount(
      stepper,
      STEPS.map(([, name, sub], index) =>
        h(
          'li',
          null,
          h(
            'button',
            {
              type: 'button',
              class: index < current ? 'complete' : '',
              'aria-current': index === current ? 'step' : null,
              onClick: () => void go(index),
            },
            h('span', { class: 'num' }, index < current ? icon('check') : index + 1),
            h('span', null, h('span', { class: 'name' }, name), h('span', { class: 'sub' }, sub)),
          ),
        ),
      ),
    );
  }

  const nav = (backLabel, nextLabel, onNext) =>
    h(
      'div',
      { class: 'builder-footer' },
      current > 0
        ? h(
            'button',
            { type: 'button', class: 'btn btn-secondary', onClick: () => void go(current - 1) },
            icon('arrow-left'),
            backLabel ?? 'Back',
          )
        : h('span'),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary',
          onClick: (e) => withBusy(e.currentTarget, onNext ?? (() => go(current + 1))),
        },
        nextLabel,
        icon('arrow-right'),
      ),
    );

  function drawAudience() {
    const name = textField({
      label: 'Campaign name',
      name: 'name',
      value: draft.name,
      required: true,
      maxlength: 160,
    });
    reading = () => {
      draft.name = name.input.value;
    };
    const picks = lists.length
      ? h(
          'div',
          { class: 'choice-grid', role: 'radiogroup', 'aria-label': 'List to send to' },
          lists.map((list) =>
            h(
              'label',
              { class: 'choice' },
              h('input', {
                type: 'radio',
                name: 'list',
                value: list.id,
                checked: draft.listId === list.id,
                onChange: () => {
                  draft.listId = list.id;
                },
              }),
              h(
                'div',
                null,
                h('div', { class: 'cell-main' }, list.name),
                h('div', { class: 'cell-sub' }, `${formatNumber(list.contactCount)} contacts`),
              ),
            ),
          ),
        )
      : emptyState({
          title: 'Create a list first',
          message: 'A campaign needs a list of contacts to send to.',
          action: h('a', { class: 'btn btn-primary', href: '/lists' }, 'Go to lists'),
        });
    return h(
      'form',
      { novalidate: true, onSubmit: (e) => e.preventDefault() },
      h(
        'div',
        { class: 'card card-pad' },
        name.el,
        h(
          'div',
          { class: 'field' },
          h('div', { class: 'label' }, 'Who should receive it?'),
          picks,
          h(
            'div',
            { class: 'help' },
            'Anyone on the suppression list is skipped automatically when you launch.',
          ),
        ),
      ),
      nav(undefined, 'Save and continue'),
    );
  }

  function drawSequence() {
    const form = h('form', {
      class: 'stack',
      novalidate: true,
      onSubmit: (e) => e.preventDefault(),
    });
    let lastField = null;
    let cumulative = 0;

    const cards = steps.map((step, index) => {
      cumulative += index === 0 ? 0 : step.delayDays;
      const subject = textField({
        label: 'Subject',
        name: 'subject',
        value: step.subject,
        required: true,
        maxlength: 200,
        placeholder: index === 0 ? 'Good to meet you, {{first_name|there}}' : 'Following up',
      });
      const text = textareaField({
        label: 'Message',
        name: 'body',
        value: step.body,
        required: true,
        rows: 8,
        placeholder:
          index === 0
            ? 'Hi {{first_name|there}},\n\nThanks for stopping by our stand…'
            : 'Hi {{first_name|there}},\n\nJust checking in…',
      });
      for (const field of [subject, text])
        field.input.addEventListener('focus', () => {
          lastField = field.input;
        });
      subject.input.addEventListener('input', () => {
        step.subject = subject.input.value;
      });
      text.input.addEventListener('input', () => {
        step.body = text.input.value;
      });
      subject.el.setAttribute('data-path', `steps.${index}.subject`);
      text.el.setAttribute('data-path', `steps.${index}.body`);

      const delay = h('input', {
        class: 'input',
        type: 'number',
        min: '0',
        max: '60',
        value: String(step.delayDays),
        'aria-label': `Days to wait before email ${index + 1}`,
        onInput: (e) => {
          step.delayDays = Math.max(0, Math.min(60, Number(e.target.value) || 0));
        },
      });
      const rail = h(
        'div',
        { class: 'step-rail' },
        h('span', { class: 'step-dot' }, index + 1),
        index === 0
          ? h('div', { class: 'step-delay' }, 'Sent first')
          : h('div', { class: 'step-delay' }, 'Wait', delay, 'days'),
        h('div', { class: 'step-delay faint' }, `Day ${cumulative}`),
      );

      const move = (by) => () => {
        [steps[index], steps[index + by]] = [steps[index + by], steps[index]];
        draw();
      };
      return h(
        'div',
        { class: 'sequence-step' },
        rail,
        h(
          'div',
          { class: 'card step-card' },
          h(
            'div',
            { class: 'card-header' },
            h('strong', null, `Email ${index + 1}`),
            h(
              'div',
              { class: 'row' },
              index > 0 &&
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn-quiet btn-icon btn-sm',
                    'aria-label': `Move email ${index + 1} up`,
                    onClick: move(-1),
                  },
                  icon('arrow-up'),
                ),
              index < steps.length - 1 &&
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn-quiet btn-icon btn-sm',
                    'aria-label': `Move email ${index + 1} down`,
                    onClick: move(1),
                  },
                  icon('arrow-down'),
                ),
              steps.length > 1 &&
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn-danger-quiet btn-icon btn-sm',
                    'aria-label': `Remove email ${index + 1}`,
                    onClick: () => {
                      steps.splice(index, 1);
                      steps[0].delayDays = 0;
                      draw();
                    },
                  },
                  icon('trash'),
                ),
            ),
          ),
          h(
            'div',
            { class: 'card-pad' },
            subject.el,
            text.el,
            h(
              'div',
              { class: 'merge-bar' },
              'Insert:',
              MERGE.map((field) =>
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => {
                      const target = lastField && form.contains(lastField) ? lastField : text.input;
                      const token = `{{${field}}}`;
                      const at = target.selectionStart ?? target.value.length;
                      target.setRangeText(token, at, target.selectionEnd ?? at, 'end');
                      target.dispatchEvent(new Event('input'));
                      target.focus();
                    },
                  },
                  `{{${field}}}`,
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-quiet btn-sm',
                  onClick: () => void previewStep(index),
                },
                icon('eye'),
                'Preview',
              ),
            ),
          ),
        ),
      );
    });

    reading = () => {};
    form.append(
      h(
        'div',
        { class: 'callout' },
        icon('info'),
        h(
          'p',
          null,
          'Use {{first_name|there}} to fall back to “there” when a first name is missing. A footer with your sender name, postal address and an unsubscribe link is added to every email automatically.',
        ),
      ),
      h('div', { class: 'sequence' }, cards),
      steps.length < MAX_STEPS
        ? h(
            'div',
            null,
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-secondary',
                onClick: () => {
                  steps.push({ subject: '', body: '', delayDays: 3 });
                  draw();
                },
              },
              icon('plus'),
              'Add a follow-up',
            ),
          )
        : null,
      nav(undefined, 'Save and continue'),
    );
    return form;
  }

  async function previewStep(index) {
    try {
      await persist();
      const { data } = await api.post(`/campaigns/${campaign.id}/preview`, { position: index + 1 });
      openModal({
        title: `Preview of email ${index + 1}`,
        description: 'Shown with sample details. Your footer is added when it sends.',
        size: 'wide',
        content: (close) =>
          h(
            'div',
            null,
            h(
              'div',
              { class: 'preview-mail' },
              h('div', { class: 'subject' }, data.subject || '(no subject)'),
              h('div', { class: 'body' }, data.body),
            ),
            h(
              'div',
              { class: 'form-actions' },
              h(
                'button',
                { type: 'button', class: 'btn btn-primary', onClick: () => close() },
                'Close',
              ),
            ),
          ),
      });
    } catch (error) {
      const form = body.querySelector('form');
      if (form && error.status === 422) showErrors(form, error);
      else toastError(error);
    }
  }

  function drawSchedule() {
    const hours = (from, to) =>
      Array.from({ length: to - from + 1 }, (_, i) => ({
        value: from + i,
        label: hourLabel(from + i),
      }));
    const start = selectField({
      label: 'Earliest send time',
      name: 'windowStartHour',
      value: draft.windowStartHour,
      options: hours(0, 23),
    });
    const end = selectField({
      label: 'Latest send time',
      name: 'windowEndHour',
      value: draft.windowEndHour,
      options: hours(1, 24),
    });
    const local = draft.startAt ? new Date(draft.startAt) : new Date(Date.now() + 3_600_000);
    const localValue = new Date(local.getTime() - local.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
    const when = h('input', {
      class: 'input',
      type: 'datetime-local',
      value: localValue,
      'aria-label': 'Start date and time',
      disabled: draft.startMode !== 'later',
    });
    const weekdays = h('input', { type: 'checkbox', checked: draft.weekdaysOnly });
    const mode = (value, title, text) =>
      h(
        'label',
        { class: 'choice' },
        h('input', {
          type: 'radio',
          name: 'start',
          value,
          checked: draft.startMode === value,
          onChange: () => {
            draft.startMode = value;
            when.disabled = value !== 'later';
          },
        }),
        h(
          'div',
          null,
          h('div', { class: 'cell-main' }, title),
          h('div', { class: 'cell-sub' }, text),
        ),
      );
    reading = () => {
      draft.windowStartHour = Number(start.input.value);
      draft.windowEndHour = Number(end.input.value);
      draft.weekdaysOnly = weekdays.checked;
      draft.startAt =
        draft.startMode === 'later' && when.value ? new Date(when.value).toISOString() : null;
    };
    return h(
      'form',
      { novalidate: true, onSubmit: (e) => e.preventDefault() },
      h(
        'div',
        { class: 'stack' },
        h(
          'section',
          { class: 'card card-pad' },
          h('h2', { class: 'card-title' }, 'When should it start?'),
          h(
            'div',
            { class: 'choice-grid', role: 'radiogroup', 'aria-label': 'Start time' },
            mode('now', 'As soon as the window allows', 'Emails start going out once you launch.'),
            mode('later', 'On a date', 'Nothing sends before this moment.'),
          ),
          h(
            'div',
            { class: 'field' },
            when,
            h(
              'div',
              { class: 'help' },
              `Uses your computer’s time zone (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`,
            ),
          ),
        ),
        h(
          'section',
          { class: 'card card-pad' },
          h('h2', { class: 'card-title' }, 'Sending window'),
          h(
            'p',
            { class: 'card-sub' },
            `Emails only go out inside this window, in your workspace time zone (${timezone}). Change it in Settings.`,
          ),
          h('div', { class: 'form-grid' }, start.el, end.el),
          h('div', { class: 'field' }, h('label', { class: 'check' }, weekdays, 'Weekdays only')),
        ),
      ),
      nav(undefined, 'Save and continue'),
    );
  }

  function drawReview() {
    const launch = campaign.launch ?? { blockers: [], eligibleRecipients: 0 };
    const list = lists.find((l) => l.id === campaign.listId);
    const blocked = launch.blockers.length > 0;
    const row = (label, ...content) =>
      h(
        'div',
        { class: 'summary-item' },
        h('div', { class: 'muted' }, label),
        h('div', null, content),
      );
    const startText = campaign.startAt
      ? `Starts ${new Date(campaign.startAt).toLocaleString()}`
      : 'Starts as soon as the window allows';

    const launchButton = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary',
        disabled: blocked,
        onClick: async (event) => {
          // currentTarget is cleared once the handler awaits, so keep a reference.
          const button = event.currentTarget;
          const ok = await confirmDialog({
            title: `Launch to ${formatNumber(launch.eligibleRecipients)} people?`,
            message: `${startText}. You can pause or cancel at any time, but emails that have already gone out cannot be recalled.`,
            confirmLabel: 'Launch campaign',
          });
          if (!ok) return;
          try {
            await withBusy(button, () =>
              api.post(`/campaigns/${campaign.id}/launch`, { version: campaign.version }),
            );
            toast('Campaign launched');
            await navigate(`/campaigns/${campaign.id}`);
          } catch (error) {
            if (error.code === 'LAUNCH_BLOCKED') {
              const { data } = await api.get(`/campaigns/${campaign.id}`);
              campaign = data;
              draw();
            }
            toastError(error);
          }
        },
      },
      icon('send'),
      'Launch campaign',
    );

    return h(
      'div',
      { class: 'stack' },
      blocked
        ? h(
            'div',
            { class: 'alert alert-warning', role: 'alert' },
            icon('alert'),
            h(
              'div',
              { class: 'alert-body' },
              h('span', { class: 'alert-title' }, 'Before you can launch'),
              h(
                'ul',
                null,
                launch.blockers.map((b) =>
                  h(
                    'li',
                    null,
                    b,
                    b.includes('Settings') && [
                      ' — ',
                      h('a', { href: '/settings' }, 'open settings'),
                    ],
                  ),
                ),
              ),
            ),
          )
        : h(
            'div',
            { class: 'alert alert-success' },
            icon('check-circle'),
            h(
              'div',
              { class: 'alert-body' },
              h('span', { class: 'alert-title' }, 'Ready to launch'),
              h(
                'span',
                null,
                `${formatNumber(launch.eligibleRecipients)} people will receive the first email.`,
              ),
            ),
          ),
      h(
        'section',
        { class: 'card card-pad' },
        h(
          'div',
          { class: 'summary-list' },
          row(
            'Audience',
            list ? `${list.name}` : 'No list chosen',
            launch.eligibleRecipients
              ? h(
                  'div',
                  { class: 'cell-sub' },
                  `${formatNumber(launch.eligibleRecipients)} can be emailed (suppressed contacts are skipped)`,
                )
              : null,
          ),
          row(
            'Sequence',
            `${campaign.steps.length} ${campaign.steps.length === 1 ? 'email' : 'emails'}`,
            h(
              'ol',
              { class: 'cell-sub' },
              campaign.steps.map((s) =>
                h(
                  'li',
                  null,
                  `${s.position === 1 ? 'Day 0' : `+${s.delayDays} days`}: ${s.subject}`,
                ),
              ),
            ),
          ),
          row(
            'Schedule',
            startText,
            h('div', { class: 'cell-sub' }, windowSentence(campaign, timezone)),
          ),
        ),
      ),
      h(
        'div',
        { class: 'builder-footer' },
        h(
          'button',
          { type: 'button', class: 'btn btn-secondary', onClick: () => void go(current - 1) },
          icon('arrow-left'),
          'Back',
        ),
        h(
          'div',
          { class: 'row' },
          h('a', { class: 'btn btn-quiet', href: '/campaigns' }, 'Save draft and exit'),
          launchButton,
        ),
      ),
    );
  }

  function draw() {
    drawChrome();
    const views = [drawAudience, drawSequence, drawSchedule, drawReview];
    mount(body, views[current]());
  }

  mount(container, header, stepper, body);
  draw();
  return () => {};
}
