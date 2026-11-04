'use strict';

const SUPABASE_URL = 'https://gjynfkzjgcgljuzrnaob.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_GyS2P9k07rKFr7rWJOzWIQ_LOACEUZz';

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const WEEKDAYS = [
  { value: 0, label: 'Domingo' },
  { value: 1, label: 'Segunda-feira' },
  { value: 2, label: 'Terça-feira' },
  { value: 3, label: 'Quarta-feira' },
  { value: 4, label: 'Quinta-feira' },
  { value: 5, label: 'Sexta-feira' },
  { value: 6, label: 'Sábado' }
];

const STATUS = {
  P: { label: 'Presente', className: 'badge-present' },
  F: { label: 'Falta', className: 'badge-absent' },
  A: { label: 'Atraso', className: 'badge-late' },
  J: { label: 'Justificada', className: 'badge-justified' }
};

const state = {
  user: null,
  classes: [],
  students: [],
  studentClasses: [],
  users: [],
  plans: [],
  lessons: [],
  attendance: [],
  classDays: [],
  attendanceEditable: false,
  showInactiveStudents: false
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&',
    '<': '<',
    '>': '>',
    '"': '&quot;',
    "'": '&#039;'
  })[character]);
}

function todayLocal() {
  const date = new Date();
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
}

function isAdmin() {
  return state.user?.role === 'admin';
}

function showMessage(message, type = 'info') {
  const element = $('#globalMessage');

  if (!element) {
    console.error(message);
    return;
  }

  element.className = `alert alert-${type}`;
  element.textContent = message;
  element.hidden = false;

  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => {
    element.hidden = true;
  }, 6000);
}

function reportError(error, fallback = 'Ocorreu um erro.') {
  console.error(error);
  showMessage(error?.message || fallback, 'danger');
}

function weekdayForDate(dateText) {
  const [year, month, day] = dateText.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function weekdayName(dayNumber) {
  return WEEKDAYS.find(day => day.value === Number(dayNumber))?.label ||
    'Dia desconhecido';
}

function formatDate(dateText) {
  if (!dateText) return '—';
  const [year, month, day] = String(dateText).slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

async function queryOrThrow(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * Chama uma Edge Function pelo cliente Supabase.
 * accessToken é enviado explicitamente quando a função exige sessão.
 */
async function invokeFunction(functionName, body, accessToken = null) {
  const options = { body };

  if (accessToken) {
    options.headers = {
      Authorization: `Bearer ${accessToken}`
    };
  }

  const { data, error } = await db.functions.invoke(functionName, options);

  if (error) {
    let detail = error.message || `Falha ao chamar ${functionName}.`;
    console.error(`Erro na função ${functionName}:`, error);

    if (error.name === 'FunctionsFetchError') {
      throw new Error(
        `Não foi possível contatar a função ${functionName}. Verifique se ela está publicada com esse nome e se o CORS permite este endereço do site.`
      );
    }
    const response = error.context;

    if (response && typeof response.clone === 'function') {
      try {
        const responseBody = await response.clone().json();
        if (responseBody?.error) detail = responseBody.error;
        else if (responseBody?.message) detail = `${responseBody.message} (HTTP ${response.status})`;
      } catch {
        // Se a resposta não for JSON, mantém a mensagem original.
      }
    }

    throw new Error(detail);
  }

  if (data?.error) throw new Error(data.error);
  return data;
}

/**
 * Carrega o perfil público associado à conta autenticada.
 */
async function loadProfile(authUser) {
  const { data, error } = await db
    .from('usuarios')
    .select('id,nome,usuario,email,role')
    .eq('id', authUser.id)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Não foi possível consultar o perfil. Confira a política RLS de usuarios. ${error.message}`
    );
  }

  if (!data) {
    throw new Error(
      'Conta autenticada, mas o perfil não foi encontrado. O UUID em usuarios deve ser igual ao UUID da conta do Supabase Auth.'
    );
  }

  return data;
}

/**
 * Login por nome de usuário usando a Edge Function smooth-function.
 * Espera access_token e refresh_token, diretamente ou dentro de session.
 */
async function login(usuario, senha) {
  const result = await invokeFunction('smooth-function', {
    usuario,
    senha
  });

  const accessToken = result?.access_token || result?.session?.access_token;
  const refreshToken = result?.refresh_token || result?.session?.refresh_token;

  if (!accessToken || !refreshToken) {
    throw new Error(
      'A Edge Function smooth-function não retornou access_token e refresh_token.'
    );
  }

  const { data, error } = await db.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken
  });

  if (error) {
    throw new Error(`Não foi possível iniciar a sessão: ${error.message}`);
  }

  if (!data.user) {
    throw new Error('Não foi possível carregar a conta autenticada.');
  }

  try {
    const profile = await loadProfile(data.user);

    profile.must_change_password =
      result.must_change_password === true ||
      result.user?.must_change_password === true ||
      data.user.app_metadata?.must_change_password === true;

    return profile;
  } catch (profileError) {
    await db.auth.signOut();
    throw profileError;
  }
}

function enterApplication(profile) {
  state.user = profile;

  const loginView = $('#loginView');
  const appView = $('#appView');

  if (loginView) loginView.hidden = true;
  if (appView) appView.hidden = false;

  if ($('#userName')) $('#userName').textContent = profile.nome || profile.usuario || 'Usuário';
  if ($('#userRole')) $('#userRole').textContent = isAdmin() ? 'Admin Master' : 'Professor';
  if ($('#userAvatar')) {
    $('#userAvatar').textContent =
      (profile.nome || profile.usuario || 'N').trim().charAt(0).toUpperCase();
  }

  $$('.admin-only').forEach(element => {
    element.hidden = !isAdmin();
  });

  $$('.plan-admin-only').forEach(element => {
    element.hidden = !isAdmin();
  });

  loadApplication().catch(error => {
    reportError(error, 'Não foi possível carregar os dados.');
  });

  if (profile.must_change_password) {
    showChangePasswordModal();
  }
}

async function logout() {
  const { error } = await db.auth.signOut();
  if (error) throw error;

  state.user = null;

  if ($('#appView')) $('#appView').hidden = true;
  if ($('#loginView')) $('#loginView').hidden = false;
  if ($('#loginForm')) $('#loginForm').reset();
}

async function loadBaseData() {
  let classQuery = db
    .from('turmas')
    .select('id,nome,modalidade,professor_id,ano_letivo');

  if (!isAdmin()) {
    classQuery = classQuery.eq('professor_id', state.user.id);
  }

  state.classes = await queryOrThrow(classQuery.order('nome'));
  const classIds = state.classes.map(item => item.id);

  state.users = isAdmin()
    ? await queryOrThrow(
        db.from('usuarios')
          .select('id,nome,usuario,email,role')
          .order('nome')
      )
    : [state.user];

  if (!classIds.length) {
    state.students = [];
    state.studentClasses = [];
    state.plans = [];
    state.lessons = [];
    state.attendance = [];
    state.classDays = [];
    return;
  }

  const [studentLinks, plans, lessons, classDays] = await Promise.all([
    queryOrThrow(
      db.from('estudantes_turmas')
        .select('estudante_id,turma_id')
        .in('turma_id', classIds)
    ),
    queryOrThrow(
      db.from('planejamentos')
        .select('id,turma_id,titulo,descricao,data_prevista,status')
        .in('turma_id', classIds)
        .order('data_prevista', { ascending: false })
    ),
    queryOrThrow(
      db.from('aulas_diario')
        .select('id,turma_id,professor_id,planejamento_id,data_aula,conteudo_ministrado')
        .in('turma_id', classIds)
        .order('data_aula', { ascending: false })
    ),
    queryOrThrow(
      db.from('turma_dias_aula')
        .select('id,turma_id,dia_semana,horario,ativo')
        .in('turma_id', classIds)
        .eq('ativo', true)
        .order('dia_semana')
    )
  ]);

  state.studentClasses = studentLinks;
  state.plans = plans;
  state.lessons = lessons;
  state.classDays = classDays;

  const studentIds = [...new Set(studentLinks.map(link => link.estudante_id))];

  state.students = studentIds.length
    ? await queryOrThrow(
        db.from('estudantes')
          .select('id,nome_completo,ativo')
          .in('id', studentIds)
          .order('nome_completo')
      )
    : [];

  const lessonIds = state.lessons.map(lesson => lesson.id);

  state.attendance = lessonIds.length
    ? await queryOrThrow(
        db.from('frequencias')
          .select('id,aula_id,estudante_id,status')
          .in('aula_id', lessonIds)
      )
    : [];
}

function className(id) {
  return state.classes.find(item => item.id === id)?.nome || 'Turma removida';
}

function teacherName(id) {
  return state.users.find(item => item.id === id)?.nome ||
    (state.user?.id === id ? state.user.nome : 'Sem professor');
}

function studentIdsInClass(classId) {
  return state.studentClasses
    .filter(link => link.turma_id === classId)
    .map(link => link.estudante_id);
}

function studentClassesFor(studentId) {
  return state.studentClasses
    .filter(link => link.estudante_id === studentId)
    .map(link => link.turma_id);
}

function statusName(status) {
  return STATUS[status]?.label || status || 'Sem registro';
}

function statusBadge(status) {
  const item = STATUS[status];
  return `<span class="badge ${item?.className || 'badge-neutral'}">${escapeHtml(statusName(status))}</span>`;
}

function populateClassSelects() {
  const options = state.classes.map(turma =>
    `<option value="${escapeHtml(turma.id)}">${escapeHtml(turma.nome)}</option>`
  ).join('');

  const attendanceSelect = $('#attendanceClass');

  if (attendanceSelect) {
    const previousClass = attendanceSelect.value;
    attendanceSelect.innerHTML =
      options || '<option value="">Sem turmas disponíveis</option>';

    if (state.classes.some(item => item.id === previousClass)) {
      attendanceSelect.value = previousClass;
    }
  }

  const studentFilter = $('#studentClassFilter');

  if (studentFilter) {
    studentFilter.innerHTML =
      '<option value="">Todas as turmas</option>' + options;
  }
}

async function loadApplication() {
  await loadBaseData();
  populateClassSelects();

  await Promise.all([
    renderDashboard(),
    renderPlans(),
    renderStudents(),
    renderClasses(),
    renderUsers()
  ]);

  if ($('#attendanceDate')) {
    $('#attendanceDate').value ||= todayLocal();
  }

  await loadAttendanceForm();
}

async function refreshApplication() {
  await loadBaseData();
  populateClassSelects();

  await Promise.all([
    renderDashboard(),
    renderPlans(),
    renderStudents(),
    renderClasses(),
    renderUsers()
  ]);

  await loadAttendanceForm();
}

async function renderDashboard() {
  if (!$('#kpiStudents')) return;

  const activeStudents = state.students.filter(student => student.ativo);
  const totalRecords = state.attendance.length;
  const presentRecords = state.attendance.filter(item => item.status === 'P').length;
  const attendanceRate = totalRecords
    ? Math.round((presentRecords / totalRecords) * 100)
    : 0;

  const completedPlans = state.plans.filter(plan => plan.status === 'realizado').length;
  const planRate = state.plans.length
    ? Math.round((completedPlans / state.plans.length) * 100)
    : 0;

  $('#kpiStudents').textContent = String(activeStudents.length);
  $('#kpiAttendance').textContent = `${attendanceRate}%`;
  $('#kpiLessons').textContent = String(state.lessons.length);
  $('#kpiPlans').textContent = `${planRate}%`;

  if ($('#recentLessonsBody')) {
    $('#recentLessonsBody').innerHTML = state.lessons.length
      ? state.lessons.slice(0, 7).map(lesson => {
          const recordCount = state.attendance.filter(
            item => item.aula_id === lesson.id
          ).length;

          return `<tr>
            <td>${escapeHtml(formatDate(lesson.data_aula))}</td>
            <td>${escapeHtml(className(lesson.turma_id))}</td>
            <td>${escapeHtml(teacherName(lesson.professor_id))}</td>
            <td>${recordCount}</td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="4"><div class="empty-state">Ainda não há chamadas registradas.</div></td></tr>';
  }

  if (!$('#activeSearchList')) return;

  const alertRows = activeStudents.map(student => {
    const studentLessons = state.attendance
      .filter(record => record.estudante_id === student.id)
      .map(record => ({
        ...record,
        lesson: state.lessons.find(lesson => lesson.id === record.aula_id)
      }))
      .filter(record => record.lesson)
      .sort((a, b) => b.lesson.data_aula.localeCompare(a.lesson.data_aula));

    if (!studentLessons.length) return null;

    const presentCount = studentLessons.filter(record => record.status === 'P').length;
    const rate = Math.round((presentCount / studentLessons.length) * 100);
    let consecutiveAbsences = 0;

    for (const record of studentLessons) {
      if (record.status === 'F') consecutiveAbsences++;
      else break;
    }

    if (rate >= 75 && consecutiveAbsences < 2) return null;

    const reason = consecutiveAbsences >= 2
      ? `${consecutiveAbsences} faltas seguidas`
      : `Frequência de ${rate}%`;

    const names = studentClassesFor(student.id).map(className).join(', ');

    return `<div class="alert-student">
      <div>
        <p class="alert-student-name">${escapeHtml(student.nome_completo)}</p>
        <p class="alert-student-detail">${escapeHtml(names)}</p>
      </div>
      <span class="badge badge-absent">${escapeHtml(reason)}</span>
    </div>`;
  }).filter(Boolean);

  $('#activeSearchList').innerHTML = alertRows.length
    ? alertRows.join('')
    : '<div class="empty-state"><p class="empty-state-title">Sem alertas no momento</p><p class="empty-state-copy">Não foram encontrados casos abaixo dos critérios de acompanhamento.</p></div>';
}

function plansForClassDate(classId, dateText) {
  return state.plans.filter(plan =>
    plan.turma_id === classId &&
    plan.data_prevista === dateText
  );
}

async function checkScheduledDay(classId, dateText) {
  if (!classId || !dateText) {
    return { scheduled: false, message: 'Selecione a turma e a data da aula.' };
  }

  const matchingPlans = plansForClassDate(classId, dateText);

  if (matchingPlans.length) {
    return {
      scheduled: true,
      message: `Data liberada: existe planejamento para ${formatDate(dateText)}.`
    };
  }

  return {
    scheduled: false,
    message: 'Não há planejamento para esta turma na data selecionada. O professor só pode registrar chamada em datas planejadas.'
  };
}

async function loadAttendanceForm() {
  if (!$('#attendanceClass') || !$('#attendanceStudentsBody')) return;

  const classId = $('#attendanceClass').value;
  const dateText = $('#attendanceDate')?.value || todayLocal();

  $('#attendanceStudentsBody').innerHTML = '';

  if ($('#attendanceNotice')) $('#attendanceNotice').hidden = true;
  if ($('#scheduledDayNotice')) $('#scheduledDayNotice').hidden = true;

  if ($('#attendancePlan')) {
    $('#attendancePlan').innerHTML =
      '<option value="">Sem planejamento vinculado</option>';
  }

  if (!classId) return;

  const plansForClass = state.plans.filter(plan => plan.turma_id === classId);
  const plansForDate = plansForClassDate(classId, dateText);

  if ($('#attendancePlan')) {
    $('#attendancePlan').innerHTML += plansForClass.map(plan =>
      `<option value="${escapeHtml(plan.id)}">${escapeHtml(formatDate(plan.data_prevista))} — ${escapeHtml(plan.titulo)}</option>`
    ).join('');
  }

  const check = await checkScheduledDay(classId, dateText);

  if ($('#scheduledDayNotice')) {
    $('#scheduledDayNotice').textContent = check.message;
    $('#scheduledDayNotice').className = check.scheduled
      ? 'alert alert-info mb-2'
      : 'alert alert-warning mb-2';
    $('#scheduledDayNotice').hidden = false;
  }

  const { data: lesson, error } = await db
    .from('aulas_diario')
    .select('id,turma_id,professor_id,planejamento_id,data_aula,conteudo_ministrado')
    .eq('turma_id', classId)
    .eq('data_aula', dateText)
    .maybeSingle();

  if (error) throw error;

  const saved = lesson
    ? await queryOrThrow(
        db.from('frequencias')
          .select('estudante_id,status')
          .eq('aula_id', lesson.id)
      )
    : [];

  const classStudentIds = studentIdsInClass(classId);
  const students = state.students.filter(student =>
    classStudentIds.includes(student.id) && student.ativo
  );

  // Professores podem criar chamadas apenas em datas planejadas.
  // Chamadas existentes são consultáveis; edição fica restrita ao Admin.
  state.attendanceEditable = isAdmin()
    ? true
    : !lesson && plansForDate.length > 0;

  if (lesson) {
    if ($('#attendanceNotes')) {
      $('#attendanceNotes').value = lesson.conteudo_ministrado || '';
    }
    if ($('#attendancePlan')) {
      $('#attendancePlan').value = lesson.planejamento_id || '';
    }

    if ($('#attendanceNotice')) {
      $('#attendanceNotice').textContent = isAdmin()
        ? 'A chamada já foi registrada. Como Admin Master, você pode alterar e salvar novamente.'
        : 'A chamada já foi registrada nesta data e está disponível para consulta.';
      $('#attendanceNotice').hidden = false;
    }
  } else if ($('#attendanceNotes')) {
    $('#attendanceNotes').value = '';
  }

  const hasStudentColumn = Boolean(
    $('#attendanceStudentsBody')?.closest('table')?.querySelector('thead th:nth-child(2)')
      ?.textContent.toLowerCase().includes('matrícula')
  );

  if ($('#attendanceStudentsBody')) {
    $('#attendanceStudentsBody').innerHTML = students.length
      ? students.map(student => {
          const savedRecord = saved.find(item => item.estudante_id === student.id);
          const selectedStatus = savedRecord?.status || 'P';
          const disabled = state.attendanceEditable ? '' : 'disabled';

          return `<tr data-student-id="${escapeHtml(student.id)}">
            <td>
              <span class="table-primary-text attendance-student-name">
                ${escapeHtml(student.nome_completo)}
              </span>
            </td>
            ${hasStudentColumn ? '<td>—</td>' : ''}
            <td>
              <div class="attendance-status-options">
                ${Object.entries(STATUS).map(([code, item]) => `
                  <button
                    type="button"
                    class="status-option ${selectedStatus === code ? 'selected' : ''}"
                    data-status="${code}"
                    aria-label="${item.label}"
                    aria-pressed="${selectedStatus === code}"
                    ${disabled}>
                    ${item.label}
                  </button>
                `).join('')}
              </div>
            </td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="${hasStudentColumn ? 3 : 2}"><div class="empty-state">Não há estudantes ativos nesta turma.</div></td></tr>`;
  }

  if ($('#attendancePlan')) $('#attendancePlan').disabled = !state.attendanceEditable;
  if ($('#attendanceNotes')) $('#attendanceNotes').readOnly = !state.attendanceEditable;
  if ($('#saveAttendanceButton')) $('#saveAttendanceButton').hidden = !state.attendanceEditable;
}

async function saveAttendance(event) {
  event.preventDefault();

  const classId = $('#attendanceClass').value;
  const dateText = $('#attendanceDate').value;

  if (!classId || !dateText) {
    throw new Error('Selecione uma turma e uma data.');
  }

  if (!isAdmin()) {
    const assignedClass = state.classes.some(item =>
      item.id === classId && item.professor_id === state.user.id
    );

    if (!assignedClass) {
      throw new Error('Você não está atribuído como professor titular desta turma.');
    }

    const scheduled = await checkScheduledDay(classId, dateText);
    if (!scheduled.scheduled) throw new Error(scheduled.message);
  }

  const selectedPlanId = $('#attendancePlan')?.value || null;

  if (selectedPlanId) {
    const selectedPlan = state.plans.find(plan =>
      plan.id === selectedPlanId &&
      plan.turma_id === classId &&
      plan.data_prevista === dateText
    );

    if (!selectedPlan) {
      throw new Error('O planejamento selecionado não corresponde à turma e à data da chamada.');
    }
  }

  const { data: existing, error: findError } = await db
    .from('aulas_diario')
    .select('id')
    .eq('turma_id', classId)
    .eq('data_aula', dateText)
    .maybeSingle();

  if (findError) throw findError;

  if (existing && !isAdmin()) {
    throw new Error('Já existe uma chamada para esta turma e data.');
  }

  let lessonId;

  if (existing) {
    const { error } = await db
      .from('aulas_diario')
      .update({
        planejamento_id: selectedPlanId,
        conteudo_ministrado: $('#attendanceNotes')?.value.trim() || null
      })
      .eq('id', existing.id);

    if (error) throw error;
    lessonId = existing.id;
  } else {
    const { data, error } = await db
      .from('aulas_diario')
      .insert({
        turma_id: classId,
        professor_id: state.user.id,
        planejamento_id: selectedPlanId,
        data_aula: dateText,
        conteudo_ministrado: $('#attendanceNotes')?.value.trim() || null
      })
      .select('id')
      .single();

    if (error?.code === '23505') {
      throw new Error('Já existe uma chamada para esta turma e data. Atualize a tela.');
    }
    if (error) throw error;
    lessonId = data.id;
  }

  const attendanceRows = $$('#attendanceStudentsBody tr[data-student-id]')
    .map(row => ({
      aula_id: lessonId,
      estudante_id: row.dataset.studentId,
      status: $('.status-option.selected', row)?.dataset.status || 'P'
    }));

  if (attendanceRows.length) {
    const { error } = await db
      .from('frequencias')
      .upsert(attendanceRows, { onConflict: 'aula_id,estudante_id' });

    if (error) throw error;
  }

  await refreshApplication();
  showMessage('Chamada salva com sucesso.');
}

async function renderPlans() {
  if (!$('#plansBody')) return;

  $('#plansBody').innerHTML = state.plans.length
    ? state.plans.map(plan => `
        <tr>
          <td>${escapeHtml(formatDate(plan.data_prevista))}</td>
          <td>${escapeHtml(className(plan.turma_id))}</td>
          <td>
            <span class="table-primary-text">${escapeHtml(plan.titulo)}</span>
            <span class="table-secondary-text">${escapeHtml(plan.descricao || '')}</span>
          </td>
          <td>
            <span class="badge ${plan.status === 'realizado' ? 'badge-completed' : 'badge-pending'}">
              ${plan.status === 'realizado' ? 'Realizado' : 'Pendente'}
            </span>
          </td>
          <td>
            ${isAdmin() && plan.status === 'pendente'
              ? `<button class="btn btn-secondary btn-sm" type="button" data-complete-plan="${escapeHtml(plan.id)}">Marcar realizado</button>`
              : '—'}
          </td>
        </tr>
      `).join('')
    : '<tr><td colspan="5"><div class="empty-state">Nenhum planejamento cadastrado.</div></td></tr>';

  const button = $('#newPlanButton');
  if (button) button.hidden = !isAdmin();
}

async function renderStudents() {
  if (!$('#studentsBody')) return;

  const filter = $('#studentClassFilter');
  const selectedClass = filter?.value || '';

  const visibleStudents = state.students.filter(student => {
    const ids = studentClassesFor(student.id);
    const matchesClass = !selectedClass || ids.includes(selectedClass);
    const matchesActive = isAdmin() && state.showInactiveStudents
      ? true
      : student.ativo;
    return matchesClass && matchesActive;
  });

  $('#studentsBody').innerHTML = visibleStudents.length
    ? visibleStudents.map(student => {
        const ids = studentClassesFor(student.id);
        const classesText = ids.map(className).join(', ');
        const records = state.attendance.filter(record =>
          record.estudante_id === student.id
        );
        const rate = records.length
          ? Math.round((records.filter(record => record.status === 'P').length / records.length) * 100)
          : null;

        return `<tr>
          <td>
            <span class="table-primary-text">${escapeHtml(student.nome_completo)}</span>
            <br>
            <button
              class="btn btn-quiet btn-sm"
              type="button"
              data-student-history="${escapeHtml(student.id)}">
              Ver histórico
            </button>
          </td>
          <td>${escapeHtml(classesText || 'Sem turma')}</td>
          <td>
            ${rate === null
              ? 'Sem registros'
              : `<span class="badge ${rate < 75 ? 'badge-absent' : 'badge-present'}">${rate}%</span>`}
          </td>
          <td>
            <span class="badge ${student.ativo ? 'badge-present' : 'badge-neutral'}">
              ${student.ativo ? 'Ativo' : 'Inativo'}
            </span>
          </td>
          ${isAdmin()
            ? `<td>
                <button class="btn btn-secondary btn-sm" type="button" data-edit-student="${escapeHtml(student.id)}">Gerenciar turmas</button>
                <button class="btn btn-secondary btn-sm" type="button" data-toggle-student="${escapeHtml(student.id)}" data-active="${student.ativo}">
                  ${student.ativo ? 'Inativar' : 'Reativar'}
                </button>
              </td>`
            : ''}
        </tr>`;
      }).join('')
    : `<tr><td colspan="${isAdmin() ? 5 : 4}"><div class="empty-state">Nenhum estudante encontrado.</div></td></tr>`;

  const header = $('#view-estudantes .page-header');
  if (header && isAdmin() && !$('#toggleInactiveStudents')) {
    const button = document.createElement('button');
    button.id = 'toggleInactiveStudents';
    button.type = 'button';
    button.className = 'btn btn-secondary';
    button.textContent = state.showInactiveStudents
      ? 'Ocultar inativos'
      : 'Mostrar inativos';
    button.addEventListener('click', async () => {
      state.showInactiveStudents = !state.showInactiveStudents;
      button.textContent = state.showInactiveStudents
        ? 'Ocultar inativos'
        : 'Mostrar inativos';
      await renderStudents();
    });

    const actions = header.querySelector('.student-actions');
    (actions || header).append(button);
  }

  if ($('#toggleInactiveStudents')) {
    $('#toggleInactiveStudents').textContent = state.showInactiveStudents
      ? 'Ocultar inativos'
      : 'Mostrar inativos';
  }
}

async function toggleStudentActive(studentId, currentlyActive) {
  if (!isAdmin()) {
    throw new Error('Apenas o Admin Master pode alterar a situação de estudantes.');
  }

  const student = state.students.find(item => item.id === studentId);
  if (!student) throw new Error('Estudante não encontrado.');

  const { error } = await db
    .from('estudantes')
    .update({ ativo: !currentlyActive })
    .eq('id', studentId);

  if (error) throw error;

  await refreshApplication();
  showMessage(
    currentlyActive
      ? 'Estudante inativado. Ele não aparecerá nas chamadas.'
      : 'Estudante reativado.'
  );
}

function showStudentHistory(studentId) {
  const student = state.students.find(item => item.id === studentId);
  if (!student) throw new Error('Estudante não encontrado.');

  const rows = state.attendance
    .filter(record => record.estudante_id === studentId)
    .map(record => {
      const lesson = state.lessons.find(item => item.id === record.aula_id);
      return lesson ? { ...record, lesson } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.lesson.data_aula.localeCompare(a.lesson.data_aula));

  const history = rows.length
    ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>Data</th><th>Turma</th><th>Status</th></tr></thead>
        <tbody>${rows.map(record => `
          <tr>
            <td>${escapeHtml(formatDate(record.lesson.data_aula))}</td>
            <td>${escapeHtml(className(record.lesson.turma_id))}</td>
            <td>${statusBadge(record.status)}</td>
          </tr>
        `).join('')}</tbody>
      </table></div>`
    : '<div class="empty-state">Ainda não há registros de frequência para este estudante.</div>';

  openModal(`Frequência: ${student.nome_completo}`, history, async () => true);
}

function studentClassOptions(selected = []) {
  return state.classes.map(turma => `
    <label class="form-field">
      <span>
        <input type="checkbox" name="turmas" value="${escapeHtml(turma.id)}"
          ${selected.includes(turma.id) ? 'checked' : ''}>
        ${escapeHtml(turma.nome)}
      </span>
    </label>
  `).join('');
}

async function createStudent() {
  if (!isAdmin()) {
    throw new Error('Apenas o Admin Master pode cadastrar estudantes.');
  }

  openModal('Cadastrar estudante', `
    <form id="studentForm" class="form-grid">
      <label class="form-field full-width">
        <span class="form-label">Nome completo</span>
        <input class="form-control" name="nome_completo" required maxlength="200">
      </label>
      <div class="form-field full-width">
        <span class="form-label">Turmas</span>
        ${studentClassOptions() || '<p class="text-muted">Cadastre uma turma antes de vincular estudantes.</p>'}
      </div>
    </form>
  `, async () => {
    const form = $('#studentForm');
    if (!form.reportValidity()) return false;

    const values = new FormData(form);
    const { data: student, error } = await db
      .from('estudantes')
      .insert({
        nome_completo: String(values.get('nome_completo') || '').trim(),
        ativo: true
      })
      .select('id')
      .single();

    if (error) throw error;

    const turmaIds = values.getAll('turmas').map(String);

    if (turmaIds.length) {
      const { error: linkError } = await db
        .from('estudantes_turmas')
        .insert(turmaIds.map(turmaId => ({
          estudante_id: student.id,
          turma_id: turmaId
        })));

      if (linkError) throw linkError;
    }

    await refreshApplication();
    return true;
  });
}

async function createStudentsBulk() {
  if (!isAdmin()) {
    throw new Error('Apenas o Admin Master pode cadastrar estudantes.');
  }

  openModal('Cadastrar estudantes por lista', `
    <form id="bulkStudentForm" class="form-grid">
      <label class="form-field full-width">
        <span class="form-label">Turmas para vincular</span>
        ${studentClassOptions() || '<p class="text-muted">Cadastre uma turma primeiro.</p>'}
      </label>
      <label class="form-field full-width">
        <span class="form-label">Lista de estudantes</span>
        <textarea class="form-control" name="lista" rows="10" required
          placeholder="Um nome por linha&#10;Exemplo: Ana Silva"></textarea>
      </label>
      <p class="text-muted full-width">Informe somente um nome por linha.</p>
    </form>
  `, async () => {
    const form = $('#bulkStudentForm');
    if (!form.reportValidity()) return false;

    const values = new FormData(form);
    const names = String(values.get('lista') || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    if (!names.length) throw new Error('Cole pelo menos um nome.');

    const students = names.map(nome => ({
      nome_completo: nome,
      ativo: true
    }));

    const { data: inserted, error } = await db
      .from('estudantes')
      .insert(students)
      .select('id');

    if (error) throw error;

    const turmaIds = values.getAll('turmas').map(String);

    if (turmaIds.length && inserted?.length) {
      const links = inserted.flatMap(student =>
        turmaIds.map(turmaId => ({
          estudante_id: student.id,
          turma_id: turmaId
        }))
      );

      const { error: linkError } = await db
        .from('estudantes_turmas')
        .insert(links);

      if (linkError) throw linkError;
    }

    await refreshApplication();
    showMessage(`${inserted?.length || 0} estudante(s) cadastrado(s).`);
    return true;
  });
}

async function editStudentClasses(studentId) {
  if (!isAdmin()) {
    throw new Error('Apenas o Admin Master pode alterar turmas.');
  }

  const student = state.students.find(item => item.id === studentId);
  if (!student) throw new Error('Estudante não encontrado.');

  const currentIds = studentClassesFor(studentId);

  openModal(`Turmas de ${student.nome_completo}`, `
    <form id="studentClassesForm">
      ${studentClassOptions(currentIds) || '<p class="text-muted">Não há turmas cadastradas.</p>'}
    </form>
  `, async () => {
    const selected = new Set(
      new FormData($('#studentClassesForm')).getAll('turmas').map(String)
    );
    const previous = new Set(studentClassesFor(studentId));
    const toDelete = [...previous].filter(id => !selected.has(id));
    const toInsert = [...selected]
      .filter(id => !previous.has(id))
      .map(turmaId => ({ estudante_id: studentId, turma_id: turmaId }));

    if (toDelete.length) {
      const { error } = await db.from('estudantes_turmas')
        .delete()
        .eq('estudante_id', studentId)
        .in('turma_id', toDelete);

      if (error) throw error;
    }

    if (toInsert.length) {
      const { error } = await db.from('estudantes_turmas').insert(toInsert);
      if (error) throw error;
    }

    await refreshApplication();
    return true;
  });
}

async function renderClasses() {
  if (!$('#classesBody')) return;

  const daysByClass = new Map();

  for (const item of state.classDays) {
    const current = daysByClass.get(item.turma_id) || [];
    current.push(weekdayName(item.dia_semana));
    daysByClass.set(item.turma_id, current);
  }

  $('#classesBody').innerHTML = state.classes.length
    ? state.classes.map(turma => `
        <tr>
          <td><span class="table-primary-text">${escapeHtml(turma.nome)}</span></td>
          <td>${escapeHtml(turma.modalidade || '—')}</td>
          <td>${escapeHtml(teacherName(turma.professor_id))}</td>
          <td>${escapeHtml((daysByClass.get(turma.id) || []).join(', ') || 'Não configurados')}</td>
          <td>${escapeHtml(turma.ano_letivo ?? '—')}</td>
          <td>
            ${isAdmin()
              ? `<button class="btn btn-secondary btn-sm" type="button" data-edit-class="${escapeHtml(turma.id)}">Editar turma</button>`
              : '—'}
          </td>
        </tr>
      `).join('')
    : '<tr><td colspan="6"><div class="empty-state">Nenhuma turma cadastrada.</div></td></tr>';
}

function dayCheckboxes(selected = []) {
  return WEEKDAYS.map(day => `
    <label class="form-field">
      <span><input type="checkbox" name="dias" value="${day.value}"
        ${selected.includes(day.value) ? 'checked' : ''}> ${day.label}</span>
    </label>
  `).join('');
}

async function createClass() {
  if (!isAdmin()) throw new Error('Apenas o Admin Master pode criar turmas.');

  const teachers = state.users.filter(user => user.role === 'professor');
  const teacherOptions = '<option value="">Sem professor atribuído</option>' +
    teachers.map(user =>
      `<option value="${escapeHtml(user.id)}">${escapeHtml(user.nome)} (${escapeHtml(user.usuario || 'sem usuário')})</option>`
    ).join('');

  openModal('Criar turma', `
    <form id="classForm" class="form-grid">
      <label class="form-field">
        <span class="form-label">Nome da turma</span>
        <input class="form-control" name="nome" required>
      </label>
      <label class="form-field">
        <span class="form-label">Modalidade</span>
        <input class="form-control" name="modalidade">
      </label>
      <label class="form-field full-width">
        <span class="form-label">Professor titular</span>
        <select class="form-control" name="professor_id">${teacherOptions}</select>
      </label>
      <label class="form-field">
        <span class="form-label">Ano letivo</span>
        <input class="form-control" name="ano_letivo" type="number" value="${new Date().getFullYear()}" required>
      </label>
      <div class="form-field full-width">
        <span class="form-label">Dias recorrentes previstos</span>
        ${dayCheckboxes()}
      </div>
    </form>
  `, async () => {
    const form = $('#classForm');
    if (!form.reportValidity()) return false;

    const values = new FormData(form);
    const { data: turma, error } = await db.from('turmas').insert({
      nome: String(values.get('nome') || '').trim(),
      modalidade: String(values.get('modalidade') || '').trim() || null,
      professor_id: String(values.get('professor_id') || '') || null,
      ano_letivo: Number(values.get('ano_letivo'))
    }).select('id').single();

    if (error) throw error;

    const days = values.getAll('dias').map(Number);

    if (days.length) {
      const { error: dayError } = await db.from('turma_dias_aula').insert(
        days.map(day => ({
          turma_id: turma.id,
          dia_semana: day,
          ativo: true
        }))
      );

      if (dayError) throw dayError;
    }

    await refreshApplication();
    return true;
  });
}

async function editClass(classId) {
  if (!isAdmin()) throw new Error('Apenas o Admin Master pode alterar turmas.');

  const turma = state.classes.find(item => item.id === classId);
  if (!turma) throw new Error('Turma não encontrada.');

  const teachers = state.users.filter(user => user.role === 'professor');
  const teacherOptions = '<option value="">Sem professor atribuído</option>' +
    teachers.map(user =>
      `<option value="${escapeHtml(user.id)}" ${user.id === turma.professor_id ? 'selected' : ''}>${escapeHtml(user.nome)} (${escapeHtml(user.usuario || 'sem usuário')})</option>`
    ).join('');

  const selectedDays = state.classDays
    .filter(item => item.turma_id === classId)
    .map(item => Number(item.dia_semana));

  openModal(`Editar turma: ${turma.nome}`, `
    <form id="editClassForm" class="form-grid">
      <label class="form-field">
        <span class="form-label">Nome da turma</span>
        <input class="form-control" name="nome" value="${escapeHtml(turma.nome)}" required>
      </label>
      <label class="form-field">
        <span class="form-label">Modalidade</span>
        <input class="form-control" name="modalidade" value="${escapeHtml(turma.modalidade || '')}">
      </label>
      <label class="form-field full-width">
        <span class="form-label">Professor titular</span>
        <select class="form-control" name="professor_id">${teacherOptions}</select>
      </label>
      <label class="form-field">
        <span class="form-label">Ano letivo</span>
        <input class="form-control" name="ano_letivo" type="number" value="${escapeHtml(turma.ano_letivo ?? '')}" required>
      </label>
      <div class="form-field full-width">
        <span class="form-label">Dias recorrentes previstos</span>
        ${dayCheckboxes(selectedDays)}
      </div>
    </form>
  `, async () => {
    const form = $('#editClassForm');
    if (!form.reportValidity()) return false;

    const values = new FormData(form);
    const { error: updateError } = await db.from('turmas').update({
      nome: String(values.get('nome') || '').trim(),
      modalidade: String(values.get('modalidade') || '').trim() || null,
      professor_id: String(values.get('professor_id') || '') || null,
      ano_letivo: Number(values.get('ano_letivo'))
    }).eq('id', classId);

    if (updateError) throw updateError;

    const selected = new Set(values.getAll('dias').map(Number));

    const { error: deactivateError } = await db.from('turma_dias_aula')
      .update({ ativo: false })
      .eq('turma_id', classId);

    if (deactivateError) throw deactivateError;

    for (const day of selected) {
      const { error } = await db.from('turma_dias_aula').upsert(
        { turma_id: classId, dia_semana: day, ativo: true },
        { onConflict: 'turma_id,dia_semana' }
      );

      if (error) throw error;
    }

    await refreshApplication();
    return true;
  });
}

async function renderUsers() {
  if (!$('#usersBody')) return;

  $('#usersBody').innerHTML = state.users.length
    ? state.users.map(user => `
        <tr>
          <td><span class="table-primary-text">${escapeHtml(user.nome)}</span></td>
          <td>${escapeHtml(user.usuario || '—')}</td>
          <td><span class="badge badge-neutral">${user.role === 'admin' ? 'Admin Master' : 'Professor'}</span></td>
        </tr>
      `).join('')
    : '<tr><td colspan="3"><div class="empty-state">Nenhum educador cadastrado.</div></td></tr>';
}

async function createEducator() {
  if (!isAdmin()) {
    throw new Error('Apenas o Admin Master pode cadastrar educadores.');
  }

  openModal('Cadastrar educador', `
    <form id="educatorForm" class="form-grid">
      <label class="form-field full-width">
        <span class="form-label">Nome</span>
        <input class="form-control" name="nome" required maxlength="120">
      </label>
      <label class="form-field full-width">
        <span class="form-label">Usuário</span>
        <input
          class="form-control"
          name="usuario"
          required
          minlength="3"
          maxlength="40"
          pattern="[a-zA-Z0-9._-]+"
          autocomplete="off">
      </label>
      <label class="form-field full-width">
        <span class="form-label">Senha inicial</span>
        <input
          class="form-control"
          name="senha"
          type="password"
          minlength="8"
          required
          autocomplete="new-password">
      </label>
    </form>
    <div class="alert alert-info mt-2">
      O educador deverá trocar a senha no primeiro acesso.
    </div>
  `, async () => {
    const form = $('#educatorForm');
    if (!form.reportValidity()) return false;

    const values = new FormData(form);
    const payload = {
      nome: String(values.get('nome') || '').trim(),
      usuario: String(values.get('usuario') || '').trim().toLowerCase(),
      senha: String(values.get('senha') || '')
    };

    const { data: { session }, error: sessionError } = await db.auth.getSession();

    if (sessionError) {
      throw new Error(`Não foi possível verificar a sessão: ${sessionError.message}`);
    }

    if (!session?.access_token) {
      throw new Error('Sua sessão expirou. Entre novamente.');
    }

    const result = await invokeFunction(
      'clever-task',
      payload,
      session.access_token
    );

    await refreshApplication();
    showMessage(`Educador ${result?.user?.nome || payload.nome} cadastrado.`);
    return true;
  });
}

async function createPlan() {
  if (!isAdmin()) {
    throw new Error('Somente o Admin Master pode criar planejamentos e liberar datas.');
  }

  if (!state.classes.length) {
    throw new Error('Não há turmas disponíveis.');
  }

  const options = state.classes.map(turma =>
    `<option value="${escapeHtml(turma.id)}">${escapeHtml(turma.nome)}</option>`
  ).join('');

  openModal('Novo planejamento e liberação de data', `
    <form id="planForm" class="form-grid">
      <label class="form-field full-width">
        <span class="form-label">Turma</span>
        <select class="form-control" name="turma_id" required>${options}</select>
      </label>
      <label class="form-field">
        <span class="form-label">Título</span>
        <input class="form-control" name="titulo" required maxlength="200">
      </label>
      <label class="form-field">
        <span class="form-label">Data prevista — libera a chamada nessa data</span>
        <input class="form-control" name="data_prevista" type="date" required>
      </label>
      <label class="form-field full-width">
        <span class="form-label">Descrição</span>
        <textarea class="form-control" name="descricao"></textarea>
      </label>
    </form>
  `, async () => {
    const form = $('#planForm');
    if (!form.reportValidity()) return false;

    const values = new FormData(form);
    const { error } = await db.from('planejamentos').insert({
      turma_id: values.get('turma_id'),
      titulo: String(values.get('titulo') || '').trim(),
      descricao: String(values.get('descricao') || '').trim() || null,
      data_prevista: values.get('data_prevista'),
      status: 'pendente'
    });

    if (error) throw error;

    await refreshApplication();
    return true;
  });
}

function openModal(title, content, onSave) {
  const root = $('#modalRoot');
  if (!root) throw new Error('O elemento modalRoot não foi encontrado no index.html.');

  root.innerHTML = `
    <div class="modal-backdrop" role="presentation">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <header class="modal-header">
          <h2 id="modalTitle" class="modal-title">${escapeHtml(title)}</h2>
          <button class="btn btn-quiet" type="button" data-close-modal>Fechar</button>
        </header>
        <div class="modal-body">${content}</div>
        <footer class="modal-footer">
          <button class="btn btn-secondary" type="button" data-close-modal>Cancelar</button>
          <button class="btn btn-primary" type="button" data-save-modal>Salvar</button>
        </footer>
      </section>
    </div>
  `;

  root.querySelectorAll('[data-close-modal]').forEach(button => {
    button.addEventListener('click', () => {
      root.innerHTML = '';
    });
  });

  root.querySelector('[data-save-modal]').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;

    try {
      if (await onSave()) root.innerHTML = '';
    } catch (error) {
      reportError(error);
    } finally {
      button.disabled = false;
    }
  });
}

function showChangePasswordModal() {
  openModal('Troca obrigatória de senha', `
    <form id="changePasswordForm" class="form-grid">
      <label class="form-field full-width">
        <span class="form-label">Nova senha</span>
        <input
          class="form-control"
          name="senha_nova"
          type="password"
          minlength="8"
          autocomplete="new-password"
          required>
      </label>
      <label class="form-field full-width">
        <span class="form-label">Confirme a nova senha</span>
        <input
          class="form-control"
          name="confirmacao"
          type="password"
          minlength="8"
          autocomplete="new-password"
          required>
      </label>
    </form>
    <div class="alert alert-info mt-2">
      Você precisa criar uma nova senha para continuar.
    </div>
  `, async () => {
    const form = $('#changePasswordForm');
    if (!form.reportValidity()) return false;

    const values = new FormData(form);
    const senhaNova = String(values.get('senha_nova') || '');
    const confirmacao = String(values.get('confirmacao') || '');

    if (senhaNova !== confirmacao) {
      throw new Error('As senhas não coincidem.');
    }

    const { data: { session }, error: sessionError } = await db.auth.getSession();

    if (sessionError) {
      throw new Error(`Não foi possível verificar a sessão: ${sessionError.message}`);
    }

    if (!session?.access_token) {
      throw new Error('Sua sessão expirou. Entre novamente.');
    }

    await invokeFunction(
      'quick-service',
      { senha_nova: senhaNova },
      session.access_token
    );

    state.user.must_change_password = false;
    showMessage('Senha alterada com sucesso.');
    return true;
  });
}

async function markPlanCompleted(planId) {
  if (!isAdmin()) {
    throw new Error('Somente o Admin Master pode alterar planejamentos.');
  }

  const { error } = await db.from('planejamentos')
    .update({ status: 'realizado' })
    .eq('id', planId);

  if (error) throw error;

  await refreshApplication();
  showMessage('Planejamento atualizado.');
}

async function exportCsv() {
  const classId = $('#attendanceClass')?.value;
  if (!classId) throw new Error('Selecione uma turma para exportar.');

  const students = state.students.filter(student =>
    student.ativo && studentIdsInClass(classId).includes(student.id)
  );

  const lessons = state.lessons
    .filter(lesson => lesson.turma_id === classId)
    .sort((a, b) => a.data_aula.localeCompare(b.data_aula));

  const rows = [['Estudante', 'Data', 'Status']];

  for (const lesson of lessons) {
    for (const student of students) {
      const record = state.attendance.find(item =>
        item.aula_id === lesson.id && item.estudante_id === student.id
      );

      rows.push([
        student.nome_completo,
        lesson.data_aula,
        record ? statusName(record.status) : 'Sem registro'
      ]);
    }
  }

  const csv = '\uFEFF' + rows
    .map(row => row.map(value =>
      `"${String(value).replaceAll('"', '""')}"`
    ).join(','))
    .join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = `frequencia-${classId}-${todayLocal()}.csv`;
  link.click();

  URL.revokeObjectURL(url);
}

function navigate(view) {
  const titles = {
    dashboard: 'Dashboard',
    chamada: 'Chamada diária',
    planejamentos: 'Planejamentos',
    estudantes: 'Estudantes',
    turmas: 'Turmas e dias de aula',
    usuarios: 'Educadores'
  };

  if (['turmas', 'usuarios', 'estudantes'].includes(view) && !isAdmin()) {
    showMessage('Você não tem permissão para acessar esta área.', 'danger');
    view = 'dashboard';
  }

  $$('.spa-view').forEach(section => {
    section.hidden = section.id !== `view-${view}`;
  });

  $$('.nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.view === view);
  });

  if ($('#topbarTitle')) {
    $('#topbarTitle').textContent = titles[view] || 'NAC';
  }
}

function bind(selector, eventName, handler) {
  const element = $(selector);
  if (element) element.addEventListener(eventName, handler);
}

bind('#loginForm', 'submit', async event => {
  event.preventDefault();

  const form = event.currentTarget;
  const values = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  const message = $('#loginMessage');

  if (button) button.disabled = true;
  if (message) message.hidden = true;

  try {
    const usernameField = form.querySelector('[name="usuario"]');
    const emailField = form.querySelector('[name="email"]');
    const username = String(
      values.get('usuario') || values.get('email') || ''
    ).trim().toLowerCase();

    if (!username) {
      throw new Error('Informe seu nome de usuário.');
    }

    // O smooth-function espera a chave usuario, mesmo se o HTML antigo
    // ainda tiver um campo chamado email.
    const profile = await login(
      usernameField || !emailField ? username : username,
      String(values.get('senha') || '')
    );

    form.reset();
    enterApplication(profile);
  } catch (error) {
    if (message) {
      message.textContent = error.message || 'Não foi possível entrar.';
      message.hidden = false;
    } else {
      reportError(error);
    }
  } finally {
    if (button) button.disabled = false;
  }
});

bind('#logoutButton', 'click', () => logout().catch(reportError));
bind('#logoutButtonTop', 'click', () => logout().catch(reportError));

bind('#sideNav', 'click', event => {
  const link = event.target.closest('[data-view]');
  if (!link) return;
  event.preventDefault();
  navigate(link.dataset.view);
});

bind('#attendanceClass', 'change', () => {
  loadAttendanceForm().catch(reportError);
});

bind('#attendanceDate', 'change', () => {
  loadAttendanceForm().catch(reportError);
});

bind('#attendanceForm', 'submit', event => {
  saveAttendance(event).catch(reportError);
});

bind('#attendanceStudentsBody', 'click', event => {
  const clicked = event.target.closest('.status-option');
  if (!clicked || !state.attendanceEditable) return;

  const row = clicked.closest('tr');

  $$('.status-option', row).forEach(button => {
    const selected = button === clicked;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
});

bind('#newUserButton', 'click', () => createEducator().catch(reportError));
bind('#newClassButton', 'click', () => createClass().catch(reportError));
bind('#newStudentButton', 'click', () => createStudent().catch(reportError));
bind('#newStudentsBulkButton', 'click', () => createStudentsBulk().catch(reportError));
bind('#newPlanButton', 'click', () => createPlan().catch(reportError));
bind('#exportCsvButton', 'click', () => exportCsv().catch(reportError));

bind('#studentClassFilter', 'change', () => {
  renderStudents().catch(reportError);
});

bind('#classesBody', 'click', event => {
  const button = event.target.closest('[data-edit-class]');
  if (button && isAdmin()) {
    editClass(button.dataset.editClass).catch(reportError);
  }
});

bind('#studentsBody', 'click', event => {
  const historyButton = event.target.closest('[data-student-history]');

  if (historyButton) {
    showStudentHistory(historyButton.dataset.studentHistory);
    return;
  }

  const editButton = event.target.closest('[data-edit-student]');

  if (editButton && isAdmin()) {
    editStudentClasses(editButton.dataset.editStudent).catch(reportError);
    return;
  }

  const toggleButton = event.target.closest('[data-toggle-student]');

  if (toggleButton && isAdmin()) {
    toggleStudentActive(
      toggleButton.dataset.toggleStudent,
      toggleButton.dataset.active === 'true'
    ).catch(reportError);
  }
});

bind('#plansBody', 'click', event => {
  const button = event.target.closest('[data-complete-plan]');
  if (button && isAdmin()) {
    markPlanCompleted(button.dataset.completePlan).catch(reportError);
  }
});

(async function restoreAuthSession() {
  if ($('#attendanceDate')) {
    $('#attendanceDate').value = todayLocal();
  }

  try {
    const { data, error } = await db.auth.getSession();
    if (error) throw error;

    const authUser = data.session?.user;
    if (!authUser) return;

    const profile = await loadProfile(authUser);
    profile.must_change_password =
      authUser.app_metadata?.must_change_password === true;

    enterApplication(profile);
  } catch (error) {
    console.error('Não foi possível restaurar a sessão:', error);
    await db.auth.signOut().catch(() => {});

    if ($('#loginView')) $('#loginView').hidden = false;
    if ($('#appView')) $('#appView').hidden = true;

    if ($('#loginMessage')) {
      $('#loginMessage').textContent =
        error.message || 'Não foi possível restaurar a sessão.';
      $('#loginMessage').hidden = false;
    }
  }
})();