// Enquiry form for Lintel's own services (Studio).
// A [data-enquiry="studio"] link opens the dialog with that interest fixed:
// the "What's it for?" field is hidden and the value is sent as-is. A bare
// [data-enquiry] link shows the field instead. Posts to /api/enquiry. The
// links point at /contact, so without this script (or without <dialog>
// support) they still go somewhere useful.
(function () {
  var dialog = document.getElementById('enquiry');
  if (!dialog || typeof dialog.showModal !== 'function') return;

  var form = dialog.querySelector('form');
  var status = dialog.querySelector('[data-enquiry-status]');
  var done = dialog.querySelector('[data-enquiry-done]');
  var submit = form.querySelector('[type="submit"]');
  var opener = null;

  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('[data-enquiry]');
    if (!trigger) return;
    e.preventDefault();
    opener = trigger;
    var interest = form.elements.interest;
    if (interest) {
      // A preset that matches an option is fixed: the field is hidden, so
      // what the visitor clicked is what gets sent.
      var preset = trigger.getAttribute('data-enquiry');
      var fixed = !!preset && [].some.call(interest.options, function (o) { return o.value === preset; });
      interest.value = fixed ? preset : 'studio';
      var field = form.querySelector('[data-enquiry-interest]');
      if (field) field.hidden = fixed;
    }
    form.hidden = false;
    done.hidden = true;
    status.textContent = '';
    dialog.showModal();
    form.elements.name.focus();
  });

  dialog.querySelectorAll('[data-enquiry-close]').forEach(function (b) {
    b.addEventListener('click', function () { dialog.close(); });
  });
  // A click on the dialog element itself is a click on the backdrop.
  dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', function () { if (opener) opener.focus(); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!form.reportValidity()) return;
    var body = {};
    new FormData(form).forEach(function (v, k) { body[k] = v; });
    submit.disabled = true;
    status.textContent = 'Sending…';
    fetch('/api/enquiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || 'Something went wrong.');
        });
      })
      .then(function () {
        form.reset();
        form.hidden = true;
        done.hidden = false;
        status.textContent = '';
      })
      .catch(function (err) {
        status.textContent = (err && err.message) || 'That didn’t send — email support@lintelapp.co.uk instead.';
      })
      .then(function () { submit.disabled = false; });
  });
})();
