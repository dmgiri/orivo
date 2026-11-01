(()=>{
 'use strict';
 document.body.classList.add('vscode-workbench');
 const title=document.getElementById('preview-panel-title');title.classList.remove('visually-hidden');title.textContent='EXPLORER';
 const explorerHeader=document.querySelector('.explorer-header'),explorerTabs=explorerHeader.querySelector('.explorer-tabs');explorerHeader.after(explorerTabs);
 const session=document.querySelector('.page-heading');document.querySelector('.trace-toolbar').after(session);session.querySelector('h1').textContent='Trace session';
 for(const button of document.querySelectorAll('[data-appearance]'))button.textContent=button.dataset.appearance==='dark'?'Dark':'Light';
 const local=document.querySelector('.wordmark');local.setAttribute('title','Orivo — local development workbench');
 document.title='Orivo';
 window.dispatchEvent(new Event('resize'));
})();
