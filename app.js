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
  authUser: null,
  classes: [],
  students: [],
  studentClasses: [],
  users: [],
  plans: [],
  lessons: [],
  attendance: [],
  classDays: [],
  attendanceEditable: false
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
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function isAdmin() {
  return state.user?.role === 'admin';
}

function showMessage(message, type = 'info') {
  const element = $('#globalMessage');
  if (!element) return console.error(message);

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

function weekdayName(dayNumber) {
  return WEEKDAYS.find(day => day.value === Number(dayNumber))?.label || 'Dia desconhecido';
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

async function loadProfile(authUser) {
  const { data, error } = await db
    .from('usuarios')
    .select('id,nome,usuario,email,role')
    .eq('id', authUser.id)
    .maybeSingle();

  if (error) {
    throw new Error(`Não foi possível consultar o perfil: ${error.message}`);
  }
  if (!data) {
    throw new Error('O perfil não foi encontrado em usuarios para esta conta Auth.');
  }
  return data;
}

async function login(usuario, senha) {
  const { data, error } = await db.functions.invoke('login-usuario', {
    body: { usuario, senha }
  });

  if (error) {
    let message = error.message || 'Falha ao chamar login-usuario.';
    const response = error.context;

    if (response && typeof response.clone === 'function') {
      try {
        const body = await response.clone().json();
        if (body?.error) message = body.error;
      } catch {
        // Usa a mensagem original.
      }
    }
    throw new Error(message);
  }

  if (data?.error) throw new Error(data.error);

  const session = data?.session || data;
  const accessToken = session?.access_token;
  const refreshToken = session?.refresh_token;

  if (!accessToken || !refreshToken) {
    throw new Error(
      'login-usuario precisa retornar access_token e refresh_token para criar a sessão.'
    );
  }

  const { data: sessionData, error: sessionError } = await db.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken
  });

  if (sessionError) throw sessionError;

  const authUser = sessionData.user || sessionData.session?.user;
  if (!authUser) throw new Error('A sessão foi criada, mas o usuário não foi retornado.');

  const profile = await loadProfile(authUser);
  state.authUser = authUser;
  return profile;
}

function enterApplication(profile) {
  state.user = profile;

  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  $('#userName').textContent = profile.nome || profile.usuario;
  $('#userRole').textContent = isAdmin() ? 'Admin Master' : 'Professor';
  $('#userAvatar').textContent =
    (profile.nome || profile.usuario || 'N').trim().charAt(0).toUpperCase();

  $$('.admin-only').forEach(element => {
    element.hidden = !isAdmin();
  });

  loadApplication().catch(error => reportError(error, 'Não foi possível carregar os dados.'));
}

async function logout() {
  const { error } = await db.auth.signOut();
  if (error) throw error;

  state.user = null;
  state.authUser = null;
  state.classes = [];
  state.students = [];
  state.studentClasses = [];
  state.users = [];
  state.plans = [];
  state.lessons = [];
  state.attendance = [];
  state.classDays = [];

  $('#appView').hidden = true;
  $('#loginView').hidden = false;
  $('#loginForm').reset();
}

function teacherName(id) {
  const teacher = state.users.find(user => user.id === id);
  return teacher?.nome || (state.user?.id === id ? state.user.nome : 'Sem professor');
}

function className(id) {
  return state.classes.find(item => item.id === id)?.nome || 'Turma removida';
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

async function loadBaseData() {
  let classQuery = db
    .from('turmas')
    .select('id,nome,modalidade,professor_id,ano_letivo');

  if (!isAdmin()) classQuery = classQuery.eq('professor_id', state.user.id);

  state.classes = await queryOrThrow(classQuery.order('nome'));
  const classIds = state.classes.map(item => item.id);

  state.users = isAdmin()
    ? await queryOrThrow(
        db.from('usuarios').select('id,nome,usuario,email,role').order('nome')
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

  const [links, plans, lessons, days] = await Promise.all([
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

  state.studentClasses = links;
  state.plans = plans;
  state.lessons = lessons;
  state.classDays = days;

  const studentIds = [...new Set(links.map(link => link.estudante_id))];

  state.students = studentIds.length
    ? await queryOrThrow(
        db.from('estudantes')
          .select('id,nome_completo,ativo')
          .in('id', studentIds)
          .eq('ativo', true)
          .order('nome_completo')
      )
    : [];

  const lessonIds = lessons.map(lesson => lesson.id);
  state.attendance = lessonIds.length
    ? await queryOrThrow(
        db.from('frequencias')
          .select('id,aula_id,estudante_id,status')
          .in('aula_id', lessonIds)
      )
    : [];
}

function populateClassSelects() {
  const options = state.classes.map(turma =>
    `<option value="${escapeHtml(turma.id)}">${escapeHtml(turma.nome)}</option>`
  ).join('');

  const attendanceSelect = $('#attendanceClass');
  const previous = attendanceSelect.value;
  attendanceSelect.innerHTML = options || '<option value="">Sem turmas disponíveis</option>';

  if (state.classes.some(item => item.id === previous)) {
    attendanceSelect.value = previous;
  }

  $('#studentClassFilter').innerHTML =
    '<option value="">Todas as turmas</option>' + options;
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

  $('#attendanceDate').value ||= todayLocal();
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
  const total = state.attendance.length;
  const present = state.attendance.filter(item => item.status === 'P').length;
  const completed = state.plans.filter(plan => plan.status === 'realizado').length;

  $('#kpiStudents').textContent = String(state.students.length);
  $('#kpiAttendance').textContent = `${total ? Math.round(present / total * 100) : 0}%`;
  $('#kpiLessons').textContent = String(state.lessons.length);
  $('#kpiPlans').textContent =
    `${state.plans.length ? Math.round(completed / state.plans.length * 100) : 0}%`;

  $('#recentLessonsBody').innerHTML = state.lessons.length
    ? state.lessons.slice(0, 7).map(lesson => {
        const count = state.attendance.filter(item => item.aula_id === lesson.id).length;
        return `<tr>
          <td>${escapeHtml(formatDate(lesson.data_aula))}</td>
          <td>${escapeHtml(className(lesson.turma_id))}</td>
          <td>${escapeHtml(teacherName(lesson.professor_id))}</td>
          <td>${count}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="4"><div class="empty-state">Ainda não há chamadas registradas.</div></td></tr>';

  const alerts = state.students.map(student => {
    const records = state.attendance
      .filter(item => item.estudante_id === student.id)
      .map(item => ({ ...item, lesson: state.lessons.find(lesson => lesson.id === item.aula_id) }))
      .filter(item => item.lesson)
      .sort((a, b) => b.lesson.data_aula.localeCompare(a.lesson.data_aula));

    if (!records.length) return '';

    const rate = Math.round(records.filter(item => item.status === 'P').length / records.length * 100);
    let absences = 0;
    for (const record of records) {
      if (record.status === 'F') absences++;
      else break;
    }
    if (rate >= 75 && absences < 2) return '';

    const classes = studentClassesFor(student.id).map(className).join(', ');
    const reason = absences >= 2 ? `${absences} faltas seguidas` : `Frequência de ${rate}%`;

    return `<div class="alert-student">
      <div>
        <p class="alert-student-name">${escapeHtml(student.nome_completo)}</p>
        <p class="alert-student-detail">${escapeHtml(classes)}</p>
      </div>
      <span class="badge badge-absent">${escapeHtml(reason)}</span>
    </div>`;
  }).filter(Boolean);

  $('#activeSearchList').innerHTML = alerts.length
    ? alerts.join('')
    : '<div class="empty-state"><p class="empty-state-title">Sem alertas no momento</p><p class="empty-state-copy">Não foram encontrados casos abaixo dos critérios de acompanhamento.</p></div>';
}

function plansForClassDate(classId, dateText) {
  return state.plans.filter(plan =>
    plan.turma_id === classId && plan.data_prevista === dateText
  );
}

async function loadAttendanceForm() {
  const classId = $('#attendanceClass').value;
  const dateText = $('#attendanceDate').value || todayLocal();

  $('#attendanceStudentsBody').innerHTML = '';
  $('#attendanceNotice').hidden = true;
  $('#scheduledDayNotice').hidden = true;
  $('#attendancePlan').innerHTML = '<option value="">Sem planejamento vinculado</option>';

  if (!classId) return;

  const classPlans = state.plans.filter(plan => plan.turma_id === classId);
  const datePlans = plansForClassDate(classId, dateText);

  $('#attendancePlan').innerHTML += classPlans.map(plan =>
    `<option value="${escapeHtml(plan.id)}">${escapeHtml(formatDate(plan.data_prevista))} — ${escapeHtml(plan.titulo)}</option>`
  ).join('');

  const scheduled = isAdmin() || datePlans.length > 0;
  $('#scheduledDayNotice').textContent = isAdmin()
    ? 'Admin Master: chamada liberada.'
    : scheduled
      ? `Data liberada: existe planejamento para ${formatDate(dateText)}.`
      : 'Não há planejamento para esta turma nesta data. A chamada não pode ser registrada.';
  $('#scheduledDayNotice').className = scheduled
    ? 'alert alert-info mb-2'
    : 'alert alert-warning mb-2';
  $('#scheduledDayNotice').hidden = false;

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
  const students = state.students.filter(student => classStudentIds.includes(student.id));

  state.attendanceEditable = isAdmin() || (!lesson && scheduled);

  if (lesson) {
    $('#attendanceNotes').value = lesson.conteudo_ministrado || '';
    $('#attendancePlan').value = lesson.planejamento_id || '';
    $('#attendanceNotice').textContent = isAdmin()
      ? 'A chamada já existe. Você pode alterá-la como Admin Master.'
      : 'A chamada já foi registrada. Está disponível somente para consulta.';
    $('#attendanceNotice').hidden = false;
  } else {
    $('#attendanceNotes').value = '';
  }

  $('#attendanceStudentsBody').innerHTML = students.length
    ? students.map(student => {
        const record = saved.find(item => item.estudante_id === student.id);
        const selected = record?.status || 'P';
        const disabled = state.attendanceEditable ? '' : 'disabled';

        return `<tr data-student-id="${escapeHtml(student.id)}">
          <td><span class="table-primary-text attendance-student-name">${escapeHtml(student.nome_completo)}</span></td>
          <td><div class="attendance-status-options">
            ${Object.entries(STATUS).map(([code, item]) => `
              <button type="button"
                class="status-option ${selected === code ? 'selected' : ''}"
                data-status="${code}"
                aria-label="${item.label}"
                aria-pressed="${selected === code}"
                ${disabled}>${item.label}</button>
            `).join('')}
          </div></td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="2"><div class="empty-state">Não há estudantes ativos nesta turma.</div></td></tr>';

  $('#attendancePlan').disabled = !state.attendanceEditable;
  $('#attendanceNotes').readOnly = !state.attendanceEditable;
  $('#saveAttendanceButton').hidden = !state.attendanceEditable;
}

async function saveAttendance(event) {
  event.preventDefault();

  const classId = $('#attendanceClass').value;
  const dateText = $('#attendanceDate').value;

  if (!classId || !dateText) throw new Error('Selecione turma e data.');
  if (!state.attendanceEditable) throw new Error('Esta chamada está somente para consulta.');

  const selectedPlanId = $('#attendancePlan').value || null;
  if (!isAdmin() && !plansForClassDate(classId, dateText).length) {
    throw new Error('Não existe planejamento para a turma e data selecionadas.');
  }

  if (selectedPlanId) {
    const plan = state.plans.find(item =>
      item.id === selectedPlanId &&
      item.turma_id === classId &&
      item.data_prevista === dateText
    );
    if (!plan) throw new Error('O planejamento não corresponde à turma e à data.');
  }

  const { data: existing, error: findError } = await db
    .from('aulas_diario')
    .select('id')
    .eq('turma_id', classId)
    .eq('data_aula', dateText)
    .maybeSingle();

  if (findError) throw findError;
  if (existing && !isAdmin()) throw new Error('Já existe chamada registrada nessa data.');

  let lessonId;

  if (existing) {
    const { error } = await db.from('aulas_diario')
      .update({
        planejamento_id: selectedPlanId,
        conteudo_ministrado: $('#attendanceNotes').value.trim() || null
      })
      .eq('id', existing.id);
    if (error) throw error;
    lessonId = existing.id;
  } else {
    const { data, error } = await db.from('aulas_diario')
      .insert({
        turma_id: classId,
        professor_id: state.user.id,
        planejamento_id: selectedPlanId,
        data_aula: dateText,
        conteudo_ministrado: $('#attendanceNotes').value.trim() || null
      })
      .select('id')
      .single();

    if (error) throw error;
    lessonId = data.id;
  }

  const rows = $$('#attendanceStudentsBody tr[data-student-id]').map(row => ({
    aula_id: lessonId,
    estudante_id: row.dataset.studentId,
    status: $('.status-option.selected', row)?.dataset.status || 'P'
  }));

  if (rows.length) {
    const { error } = await db.from('frequencias')
      .upsert(rows, { onConflict: 'aula_id,estudante_id' });
    if (error) throw error;
  }

  await refreshApplication();
  showMessage('Chamada salva com sucesso.');
}

async function renderPlans() {
  $('#plansBody').innerHTML = state.plans.length
    ? state.plans.map(plan => `
      <tr>
        <td>${escapeHtml(formatDate(plan.data_prevista))}</td>
        <td>${escapeHtml(className(plan.turma_id))}</td>
        <td><span class="table-primary-text">${escapeHtml(plan.titulo)}</span>
          <span class="table-secondary-text">${escapeHtml(plan.descricao || '')}</span></td>
        <td><span class="badge ${plan.status === 'realizado' ? 'badge-completed' : 'badge-pending'}">
          ${plan.status === 'realizado' ? 'Realizado' : 'Pendente'}
        </span></td>
        <td>${isAdmin() && plan.status !== 'realizado'
          ? `<button class="btn btn-secondary btn-sm" type="button" data-complete-plan="${escapeHtml(plan.id)}">Marcar realizado</button>`
          : '—'}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="5"><div class="empty-state">Nenhum planejamento cadastrado.</div></td></tr>';
}

async function renderStudents() {
  const selectedClass = $('#studentClassFilter').value;
  const visible = state.students.filter(student =>
    !selectedClass || studentClassesFor(student.id).includes(selectedClass)
  );

  $('#studentsBody').innerHTML = visible.length
    ? visible.map(student => {
        const classIds = studentClassesFor(student.id);
        const records = state.attendance.filter(item => item.estudante_id === student.id);
        const rate = records.length
          ? Math.round(records.filter(item => item.status === 'P').length / records.length * 100)
          : null;

        return `<tr>
          <td><span class="table-primary-text">${escapeHtml(student.nome_completo)}</span>
            <br><button class="btn btn-quiet btn-sm" type="button" data-student-history="${escapeHtml(student.id)}">Ver histórico</button></td>
          <td>${escapeHtml(classIds.map(className).join(', ') || 'Sem turma')}</td>
          <td>${rate === null ? 'Sem registros' : `<span class="badge ${rate < 75 ? 'badge-absent' : 'badge-present'}">${rate}%</span>`}</td>
          <td><span class="badge badge-present">Ativo</span></td>
          <td>
            <button class="btn btn-secondary btn-sm" type="button" data-edit-student="${escapeHtml(student.id)}">Turmas</button>
            <button class="btn btn-danger btn-sm" type="button" data-toggle-student="${escapeHtml(student.id)}" data-active="true">Inativar</button>
          </td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="5"><div class="empty-state">Nenhum estudante encontrado.</div></td></tr>';
}

function showStudentHistory(studentId) {
  const student = state.students.find(item => item.id === studentId);
  if (!student) return;

  const records = state.attendance
    .filter(item => item.estudante_id === studentId)
    .map(item => ({ ...item, lesson: state.lessons.find(lesson => lesson.id === item.aula_id) }))
    .filter(item => item.lesson)
    .sort((a, b) => b.lesson.data_aula.localeCompare(a.lesson.data_aula));

  const content = records.length
    ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>Data</th><th>Turma</th><th>Status</th></tr></thead>
        <tbody>${records.map(item => `<tr>
          <td>${escapeHtml(formatDate(item.lesson.data_aula))}</td>
          <td>${escapeHtml(className(item.lesson.turma_id))}</td>
          <td>${statusBadge(item.status)}</td>
        </tr>`).join('')}</tbody></table></div>`
    : '<div class="empty-state">Ainda não há registros de frequência.</div>';

  openModal(`Frequência: ${student.nome_completo}`, content, async () => true);
}

function studentClassOptions(selected = []) {
  return state.classes.map(turma => `
    <label class="form-field">
      <span><input type="checkbox" name="turmas" value="${escapeHtml(turma.id)}"
        ${selected.includes(turma.id) ? 'checked' : ''}> ${escapeHtml(turma.nome)}</span>
    </label>
  `).join('');
}

async function createStudent() {
  if (!isAdmin()) throw new Error('Apenas o Admin Master pode cadastrar estudantes.');

  openModal('Cadastrar estudante', `
    <form id="studentForm" class="form-grid">
      <label class="form-field full-width">
        <span class="form-label">Nome completo</span>
        <input class="form-control" name="nome_completo" required maxlength="200">
      </label>
      <div class="form-field full-width">
        <span class="form-label">Turmas</span>
        ${studentClassOptions() || '<p class="text-muted">Cadastre uma turma primeiro.</p>'}
      </div>
    </form>
  `, async () => {
    const form = $('#studentForm');
    if (!form.reportValidity()) return false;

    const values = new FormData(form);
    const { data: student, error } = await db.from('estudantes')
      .insert({
        nome_completo: String(values.get('nome_completo')).trim(),
        ativo: true
      })
      .select('id')
      .single();

    if (error) throw error;

    const classIds = values.getAll('turmas').map(String);
    if (classIds.length) {
      const { error: linkError } = await db.from('estudantes_turmas').insert(
        classIds.map(turmaId => ({ estudante_id: student.id, turma_id: turmaId }))
      );
      if (linkError) throw linkError;
    }

    await refreshApplication();
    return true;
  });
}

async function createStudentsBulk() {
  if (!isAdmin()) throw new Error('Apenas o Admin Master pode cadastrar estudantes.');

  openModal('Cadastrar estudantes por lista', `
    <form id="bulkStudentForm" class="form-grid">
      <div class="form-field full-width">
        <span class="form-label">Turmas para vincular</span>
        ${studentClassOptions() || '<p class="text-muted">Cadastre uma turma primeiro.</p>'}
      </div>
      <label class="form-field full-width">
        <span class="form-label">Lista de estudantes</span>
        <textarea class="form-control" name="lista" rows="10" required
          placeholder="Um nome por linha"></textarea>
      </label>
      <p class="text-muted full-width">Use uma linha por estudante; informe somente o nome.</p>
    </form>
  `, async () => {
    const form = $('#bulkStudentForm');
    if (!form.reportValidity()) return false;

    const values = new FormData(form);
    const lines = String(values.get('lista') || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    if (!lines.length) throw new Error('Informe pelo menos um nome.');

    const students = lines.map((nome, index) => {
      if (!nome) throw new Error(`A linha ${index + 1} não contém um nome.`);
      return { nome_completo: nome, ativo: true };
    });

    const { data: inserted, error } = await db.from('estudantes')
      .insert(students)
      .select('id');

    if (error) throw error;

    const classIds = values.getAll('turmas').map(String);
    if (classIds.length && inserted?.length) {
      const links = inserted.flatMap(student =>
        classIds.map(turmaId => ({ estudante_id: student.id, turma_id: turmaId }))
      );
      const { error: linkError } = await db.from('estudantes_turmas').insert(links);
      if (linkError) throw linkError;
    }

    await refreshApplication();
    showMessage(`${inserted?.length || 0} estudante(s) cadastrado(s).`);
    return true;
  });
}

async function toggleStudent(studentId, active) {
  if (!isAdmin()) throw new Error('Apenas o Admin Master pode alterar estudantes.');

  const { error } = await db.from('estudantes')
    .update({ ativo: !active })
    .eq('id', studentId);

  if (error) throw error;
  await refreshApplication();
  showMessage(active ? 'Estudante inativado.' : 'Estudante reativado.');
}

async function editStudentClasses(studentId) {
  if (!isAdmin()) throw new Error('Apenas o Admin Master pode alterar vínculos.');

  const student = state.students.find(item => item.id === studentId);
  if (!student) throw new Error('Estudante não encontrado.');

  const previous = new Set(studentClassesFor(studentId));

  openModal(`Turmas de ${student.nome_completo}`, `
    <form id="studentClassesForm">${studentClassOptions([...previous])}</form>
  `, async () => {
    const selected = new Set(new FormData($('#studentClassesForm')).getAll('turmas').map(String));
    const remove = [...previous].filter(id => !selected.has(id));
    const add = [...selected].filter(id => !previous.has(id));

    if (remove.length) {
      const { error } = await db.from('estudantes_turmas')
        .delete().eq('estudante_id', studentId).in('turma_id', remove);
      if (error) throw error;
    }

    if (add.length) {
      const { error } = await db.from('estudantes_turmas').insert(
        add.map(turmaId => ({ estudante_id: studentId, turma_id: turmaId }))
      );
      if (error) throw error;
    }

    await refreshApplication();
    return true;
  });
}

async function renderClasses() {
  const daysByClass = new Map();

  state.classDays.forEach(item => {
    const days = daysByClass.get(item.turma_id) || [];
    days.push(weekdayName(item.dia_semana));
    daysByClass.set(item.turma_id, days);
  });

  $('#classesBody').innerHTML = state.classes.length
    ? state.classes.map(turma => `<tr>
        <td><span class="table-primary-text">${escapeHtml(turma.nome)}</span></td>
        <td>${escapeHtml(turma.modalidade || '—')}</td>
        <td>${escapeHtml(teacherName(turma.professor_id))}</td>
        <td>${escapeHtml((daysByClass.get(turma.id) || []).join(', ') || 'Não configurados')}</td>
        <td>${escapeHtml(turma.ano_letivo)}</td>
        <td><button class="btn btn-secondary btn-sm" type="button" data-edit-class="${escapeHtml(turma.id)}">Editar turma</button></td>
      </tr>`).join('')
    : '<tr><td colspan="6"><div class="empty-state">Nenhuma turma cadastrada.</div></td></tr>';
}

function dayCheckboxes(selected = []) {
  return WEEKDAYS.map(day => `
    <label class="form-field"><span><input type="checkbox" name="dias" value="${day.value}"
      ${selected.includes(day.value) ? 'checked' : ''}> ${day.label}</span></label>
  `).join('');
}

function teacherOptions(selectedId = '') {
  return '<option value="">Sem professor atribuído</option>' +
    state.users.filter(user => user.role === 'professor').map(user =>
      `<option value="${escapeHtml(user.id)}" ${user.id === selectedId ? 'selected' : ''}>
        ${escapeHtml(user.nome)} (${escapeHtml(user.usuario || '')})
      </option>`
    ).join('');
}

async function createClass() {
  if (!isAdmin()) throw new Error('Apenas o Admin Master pode criar turmas.');

  openModal('Criar turma', `
    <form id="classForm" class="form-grid">
      <label class="form-field"><span class="form-label">Nome da turma</span><input class="form-control" name="nome" required></label>
      <label class="form-field"><span class="form-label">Modalidade</span><input class="form-control" name="modalidade"></label>
      <label class="form-field full-width"><span class="form-label">Professor titular</span><select class="form-control" name="professor_id">${teacherOptions()}</select></label>
      <label class="form-field"><span class="form-label">Ano letivo</span><input class="form-control" name="ano_letivo" type="number" value="${new Date().getFullYear()}" required></label>
      <div class="form-field full-width"><span class="form-label">Dias de aula</span>${dayCheckboxes()}</div>
    </form>
  `, async () => {
    const form = $('#classForm');
    if (!form.reportValidity()) return false;

    const values = new FormData(form);
    const { data: turma, error } = await db.from('turmas').insert({
      nome: String(values.get('nome')).trim(),
      modalidade: String(values.get('modalidade') || '').trim() || null,
      professor_id: String(values.get('professor_id') || '') || null,
      ano_letivo: Number(values.get('ano_letivo'))
    }).select('id').single();

    if (error) throw error;

    const days = values.getAll('dias').map(Number);
    if (days.length) {
      const { error: dayError } = await db.from('turma_dias_aula').insert(
        days.map(dia_semana => ({ turma_id: turma.id, dia_semana, ativo: true }))
      );
      if (dayError) throw dayError;
    }

    await refreshApplication();
    return true;
  });
}

async function editClass(classId) {
  if (!isAdmin()) throw new Error('Apenas o Admin Master pode editar turmas.');
  const turma = state.classes.find(item => item.id === classId);
  if (!turma) throw new Error('Turma não encontrada.');

  const selectedDays = state.classDays
    .filter(item => item.turma_id === classId)
    .map(item => Number(item.dia_semana));

  openModal(`Editar turma: ${turma.nome}`, `
    <form id="editClassForm" class="form-grid">
      <label class="form-field"><span class="form-label">Nome da turma</span><input class="form-control" name="nome" value="${escapeHtml(turma.nome)}" required></label>
      <label class="form-field"><span class="form-label">Modalidade</span><input class="form-control" name="modalidade" value="${escapeHtml(turma.modalidade || '')}"></label>
      <label class="form-field full-width"><span class="form-label">Professor titular</span><select class="form-control" name="professor_id">${teacherOptions(turma.professor_id || '')}</select></label>
      <label class="form-field"><span class="form-label">Ano letivo</span><input class="form-control" name="ano_letivo" type="number" value="${escapeHtml(turma.ano_letivo)}" required></label>
      <div class="form-field full-width"><span class="form-label">Dias de aula</span>${dayCheckboxes(selectedDays)}</div>
    </form>
  `, async () => {
    const form = $('#editClassForm');
    if (!form.reportValidity()) return false;

    const values = new FormData(form);
    const { error } = await db.from('turmas').update({
      nome: String(values.get('nome')).trim(),
      modalidade: String(values.get('modalidade') || '').trim() || null,
      professor_id: String(values.get('professor_id') || '') || null,
      ano_letivo: Number(values.get('ano_letivo'))
    }).eq('id', classId);

    if (error) throw error;

    const selected = new Set(values.getAll('dias').map(Number));
    const { error: deactivateError } = await db.from('turma_dias_aula')
      .update({ ativo: false }).eq('turma_id', classId);
    if (deactivateError) throw deactivateError;

    for (const dia_semana of selected) {
      const { error: dayError } = await db.from('turma_dias_aula').upsert(
        { turma_id: classId, dia_semana, ativo: true },
        { onConflict: 'turma_id,dia_semana' }
      );
      if (dayError) throw dayError;
    }

    await refreshApplication();
    return true;
  });
}

async function renderUsers() {
  $('#usersBody').innerHTML = state.users.length
    ? state.users.map(user => `<tr>
        <td><span class="table-primary-text">${escapeHtml(user.nome)}</span></td>
        <td>${escapeHtml(user.usuario || '—')}</td>
        <td><span class="badge badge-neutral">${user.role === 'admin' ? 'Admin Master' : 'Professor'}</span></td>
      </tr>`).join('')
    : '<tr><td colspan="3"><div class="empty-state">Nenhum educador cadastrado.</div></td></tr>';
}

async function createEducator() {
  if (!isAdmin()) throw new Error('Apenas o Admin Master pode cadastrar educadores.');

  openModal('Cadastrar educador', `
    <form id="educatorForm" class="form-grid">
      <label class="form-field full-width"><span class="form-label">Nome completo</span><input class="form-control" name="nome" required maxlength="120"></label>
      <label class="form-field full-width"><span class="form-label">Usuário</span><input class="form-control" name="usuario" required minlength="3" maxlength="40" pattern="[a-zA-Z0-9._-]+" autocomplete="username"></label>
      <label class="form-field full-width"><span class="form-label">Senha inicial</span><input class="form-control" name="senha" type="password" minlength="8" required autocomplete="new-password"></label>
    </form>
    <div class="alert alert-info mt-2">O educador deverá trocar a senha no primeiro acesso.</div>
  `, async () => {
    const form = $('#educatorForm');
    if (!form.reportValidity()) return false;

    const values = new FormData(form);
    const payload = {
      nome: String(values.get('nome') || '').trim(),
      usuario: String(values.get('usuario') || '').trim().toLowerCase(),
      senha: String(values.get('senha') || '')
    };

    const { data: sessionData, error: sessionError } = await db.auth.getSession();
    if (sessionError) throw sessionError;
    const token = sessionData.session?.access_token;
    if (!token) throw new Error('Sua sessão expirou. Entre novamente.');

    const { data, error } = await db.functions.invoke('clever-task', {
      body: payload,
      headers: { Authorization: `Bearer ${token}` }
    });

    if (error) {
      let message = error.message || 'Não foi possível cadastrar o educador.';
      if (error.context && typeof error.context.clone === 'function') {
        try {
          const body = await error.context.clone().json();
          if (body?.error) message = body.error;
        } catch {
          // Mantém mensagem original.
        }
      }
      throw new Error(message);
    }
    if (data?.error) throw new Error(data.error);

    await refreshApplication();
    showMessage(`Educador ${data?.user?.nome || payload.nome} cadastrado.`);
    return true;
  });
}

async function createPlan() {
  if (!isAdmin()) throw new Error('Somente o Admin Master pode criar planejamentos.');
  if (!state.classes.length) throw new Error('Não há turmas disponíveis.');

  const options = state.classes.map(turma =>
    `<option value="${escapeHtml(turma.id)}">${escapeHtml(turma.nome)}</option>`
  ).join('');

  openModal('Novo planejamento', `
    <form id="planForm" class="form-grid">
      <label class="form-field full-width"><span class="form-label">Turma</span><select class="form-control" name="turma_id" required>${options}</select></label>
      <label class="form-field"><span class="form-label">Título</span><input class="form-control" name="titulo" required maxlength="200"></label>
      <label class="form-field"><span class="form-label">Data prevista</span><input class="form-control" name="data_prevista" type="date" required></label>
      <label class="form-field full-width"><span class="form-label">Descrição</span><textarea class="form-control" name="descricao"></textarea></label>
    </form>
  `, async () => {
    const form = $('#planForm');
    if (!form.reportValidity()) return false;

    const values = new FormData(form);
    const { error } = await db.from('planejamentos').insert({
      turma_id: values.get('turma_id'),
      titulo: String(values.get('titulo')).trim(),
      descricao: String(values.get('descricao') || '').trim() || null,
      data_prevista: values.get('data_prevista'),
      status: 'pendente'
    });

    if (error) throw error;
    await refreshApplication();
    return true;
  });
}

async function markPlanCompleted(planId) {
  if (!isAdmin()) throw new Error('Somente o Admin Master pode alterar planejamentos.');

  const { error } = await db.from('planejamentos')
    .update({ status: 'realizado' }).eq('id', planId);

  if (error) throw error;
  await refreshApplication();
  showMessage('Planejamento atualizado.');
}

function openModal(title, content, onSave) {
  const root = $('#modalRoot');
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
    </div>`;

  root.querySelectorAll('[data-close-modal]').forEach(button => {
    button.addEventListener('click', () => { root.innerHTML = ''; });
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

async function exportCsv() {
  const classId = $('#attendanceClass').value;
  if (!classId) throw new Error('Selecione uma turma.');

  const students = state.students.filter(student => studentIdsInClass(classId).includes(student.id));
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

  const csv = '\uFEFF' + rows.map(row =>
    row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')
  ).join('\r\n');

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

  if (view === 'estudantes' && !isAdmin()) view = 'dashboard';
  if (['turmas', 'usuarios'].includes(view) && !isAdmin()) view = 'dashboard';

  $$('.spa-view').forEach(section => {
    section.hidden = section.id !== `view-${view}`;
  });

  $$('.nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.view === view);
  });

  $('#topbarTitle').textContent = titles[view] || 'NAC';
}

async function requireInitialPasswordChange() {
  const modalContent = `
    <p class="text-muted">Por segurança, defina uma nova senha para continuar.</p>
    <form id="initialPasswordForm" class="form-grid">
      <label class="form-field full-width">
        <span class="form-label">Nova senha</span>
        <input class="form-control" name="senha_nova" type="password" minlength="8" required autocomplete="new-password">
      </label>
      <label class="form-field full-width">
        <span class="form-label">Confirme a nova senha</span>
        <input class="form-control" name="confirmacao" type="password" minlength="8" required autocomplete="new-password">
      </label>
    </form>`;

  return new Promise((resolve, reject) => {
    openModal('Troca obrigatória de senha', modalContent, async () => {
      const form = $('#initialPasswordForm');
      if (!form.reportValidity()) return false;

      const values = new FormData(form);
      const senhaNova = String(values.get('senha_nova') || '');
      const confirmacao = String(values.get('confirmacao') || '');

      if (senhaNova !== confirmacao) throw new Error('As senhas não coincidem.');

      const { data, error } = await db.functions.invoke('trocar-senha-inicial', {
        body: { senha_nova: senhaNova }
      });

      if (error) {
        let message = error.message || 'Não foi possível trocar a senha.';
        if (error.context && typeof error.context.clone === 'function') {
          try {
            const body = await error.context.clone().json();
            if (body?.error) message = body.error;
          } catch {
            // Mantém a mensagem original.
          }
        }
        throw new Error(message);
      }
      if (data?.error) throw new Error(data.error);

      resolve(true);
      return true;
    });

    // Bloqueia fechamento voluntário até a troca ser concluída.
    $('#modalRoot').querySelectorAll('[data-close-modal]').forEach(button => {
      button.disabled = true;
    });
  });
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();

  const form = event.currentTarget;
  const values = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  const message = $('#loginMessage');

  button.disabled = true;
  message.hidden = true;

  try {
    const profile = await login(
      String(values.get('usuario') || '').trim().toLowerCase(),
      String(values.get('senha') || '')
    );

    const { data } = await db.auth.getUser();
    const authUser = data.user;
    const mustChange = authUser?.app_metadata?.must_change_password === true;

    if (mustChange) await requireInitialPasswordChange();

    form.reset();
    enterApplication(profile);
  } catch (error) {
    message.textContent = error.message || 'Não foi possível entrar.';
    message.hidden = false;
  } finally {
    button.disabled = false;
  }
});

$('#logoutButton').addEventListener('click', () => logout().catch(reportError));
$('#logoutButtonTop').addEventListener('click', () => logout().catch(reportError));

$('#sideNav').addEventListener('click', event => {
  const link = event.target.closest('[data-view]');
  if (!link) return;
  event.preventDefault();
  navigate(link.dataset.view);
});

$('#attendanceClass').addEventListener('change', () => loadAttendanceForm().catch(reportError));
$('#attendanceDate').addEventListener('change', () => loadAttendanceForm().catch(reportError));
$('#attendanceForm').addEventListener('submit', event => saveAttendance(event).catch(reportError));

$('#attendanceStudentsBody').addEventListener('click', event => {
  const button = event.target.closest('.status-option');
  if (!button || !state.attendanceEditable) return;

  $$('.status-option', button.closest('tr')).forEach(option => {
    const selected = option === button;
    option.classList.toggle('selected', selected);
    option.setAttribute('aria-pressed', String(selected));
  });
});

$('#newUserButton').addEventListener('click', () => createEducator().catch(reportError));
$('#newClassButton').addEventListener('click', () => createClass().catch(reportError));
$('#newStudentButton').addEventListener('click', () => createStudent().catch(reportError));
$('#newStudentsBulkButton').addEventListener('click', () => createStudentsBulk().catch(reportError));
$('#newPlanButton').addEventListener('click', () => createPlan().catch(reportError));
$('#exportCsvButton').addEventListener('click', () => exportCsv().catch(reportError));
$('#studentClassFilter').addEventListener('change', () => renderStudents().catch(reportError));

$('#classesBody').addEventListener('click', event => {
  const button = event.target.closest('[data-edit-class]');
  if (button && isAdmin()) editClass(button.dataset.editClass).catch(reportError);
});

$('#studentsBody').addEventListener('click', event => {
  const history = event.target.closest('[data-student-history]');
  if (history) return showStudentHistory(history.dataset.studentHistory);

  const edit = event.target.closest('[data-edit-student]');
  if (edit && isAdmin()) {
    editStudentClasses(edit.dataset.editStudent).catch(reportError);
    return;
  }

  const toggle = event.target.closest('[data-toggle-student]');
  if (toggle && isAdmin()) {
    toggleStudent(toggle.dataset.toggleStudent, toggle.dataset.active === 'true').catch(reportError);
  }
});

$('#plansBody').addEventListener('click', event => {
  const button = event.target.closest('[data-complete-plan]');
  if (button && isAdmin()) markPlanCompleted(button.dataset.completePlan).catch(reportError);
});

(async function restoreAuthSession() {
  $('#attendanceDate').value = todayLocal();

  try {
    const { data, error } = await db.auth.getSession();
    if (error) throw error;
    if (!data.session?.user) return;

    const authUser = data.session.user;
    const profile = await loadProfile(authUser);
    state.authUser = authUser;

    if (authUser.app_metadata?.must_change_password === true) {
      $('#loginView').hidden = false;
      $('#appView').hidden = true;
      await requireInitialPasswordChange();
    }

    enterApplication(profile);
  } catch (error) {
    console.error('Não foi possível restaurar a sessão:', error);
    await db.auth.signOut().catch(() => {});
    $('#loginView').hidden = false;
    $('#appView').hidden = true;
    $('#loginMessage').textContent = error.message || 'Não foi possível restaurar a sessão.';
    $('#loginMessage').hidden = false;
  }
})();