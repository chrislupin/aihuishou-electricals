(() => {
  if (new URLSearchParams(location.search).get('role') !== 'accountant') return;

  const translations = {
    'Operations workspace': '运营工作区', 'Overview & unapproved': '概览和待审批', 'Overview & approved': '概览和已审批',
    'Pickup dates approval': '取件日期审批', 'Ticket Center': '工单中心', 'Expenses': '费用', 'Inventory': '库存',
    'Analysis': '分析', 'Log out': '退出登录', 'Refresh data': '刷新数据', 'Accountant approvals': '会计审批',
    'Accountant inventory': '会计库存', 'Accountant finance': '会计财务', 'Accountant analysis': '会计分析',
    'Employee expenses': '员工费用', 'Record expenses': '记录费用', 'People': '人员', 'Expense types': '费用类型',
    'Person not on the list': '不在名单中的人员', 'Add person': '添加人员', 'Meal': '餐费', 'Transport': '交通费',
    'Credit/Bundle': '话费/流量包', 'Other (specify)': '其他（请说明）', 'Other expense': '其他费用',
    'Amount per person and type (KSh)': '每人每项金额（肯尼亚先令）', 'Date': '日期',
    'Notes for this batch (optional)': '此批次备注（可选）', 'Save expenses': '保存费用',
    'Expense summary report': '费用汇总报告', 'Generate & download summary': '生成并下载汇总', 'From': '从', 'To': '至',
    'Apply period': '应用期间', 'Goods spent': '商品支出', 'Expenses spent': '费用支出', 'Grand total': '总计',
    'Recorded expenses': '已记录费用', 'Goods totals by employee': '按员工统计的商品总额',
    'Expense totals by employee': '按员工统计的费用总额', 'Live goods totals': '实时商品总额',
    'Approved total quantity': '已审批总数量', 'Approved total amount': '已审批总金额', 'Goods types': '商品种类',
    'Goods from approved tickets': '已审批工单中的商品', 'Approved quantity': '已审批数量',
    'Approved amount': '已审批金额', 'Goods': '商品', 'No approved goods have been recorded yet.': '尚未记录已审批商品。',
    'Collection analysis': '收集分析', 'Report type': '报告类型', 'Approved tickets': '已审批工单',
    'Pending approval': '待审批', 'All time': '所有时间', 'Generate report': '生成报告', 'Clear filters': '清除筛选',
    'Search': '搜索', 'Employee / agent': '员工/代理', 'Status': '状态', 'Approved': '已审批', 'Rejected': '已拒绝',
    'Details': '详情', 'Edit': '编辑', 'Delete': '删除', 'Cancel': '取消', 'Close': '关闭', 'Save tracked edit': '保存已跟踪编辑'
  };
  const savedText = new WeakMap();
  const savedAttributes = new WeakMap();
  const languageKey = 'aihuishou-accountant-language';
  let language = localStorage.getItem(languageKey) === 'zh' ? 'zh' : 'en';

  function translateText(node) {
    if (!savedText.has(node)) savedText.set(node, node.nodeValue);
    const source = savedText.get(node);
    const key = source.trim();
    node.nodeValue = language === 'zh' && translations[key] ? source.replace(key, translations[key]) : source;
  }

  function translateElement(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(translateText);
    element.querySelectorAll?.('[placeholder], [aria-label], [title]').forEach((item) => {
      if (!savedAttributes.has(item)) savedAttributes.set(item, {});
      const saved = savedAttributes.get(item);
      ['placeholder', 'aria-label', 'title'].forEach((attribute) => {
        if (!item.hasAttribute(attribute)) return;
        if (!(attribute in saved)) saved[attribute] = item.getAttribute(attribute);
        const source = saved[attribute];
        item.setAttribute(attribute, language === 'zh' && translations[source] ? translations[source] : source);
      });
    });
  }

  function applyLanguage(nextLanguage) {
    language = nextLanguage === 'zh' ? 'zh' : 'en';
    localStorage.setItem(languageKey, language);
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    translateElement(document.body);
    document.querySelectorAll('[data-accountant-language]').forEach((button) => button.classList.toggle('is-active', button.dataset.accountantLanguage === language));
  }

  function addSwitcher() {
    const target = document.querySelector('.header');
    if (!target || target.querySelector('.accountant-language-switcher')) return;
    const control = document.createElement('div');
    control.className = 'accountant-language-switcher';
    control.setAttribute('aria-label', 'Language selector');
    control.innerHTML = '<button type="button" data-accountant-language="en">EN</button><button type="button" data-accountant-language="zh">中文</button>';
    control.addEventListener('click', (event) => {
      const button = event.target.closest('[data-accountant-language]');
      if (button) applyLanguage(button.dataset.accountantLanguage);
    });
    target.append(control);
    applyLanguage(language);
  }

  const style = document.createElement('style');
  style.textContent = '.accountant-language-switcher{display:inline-flex;align-items:center;align-self:center;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff;box-shadow:0 5px 12px #14538812}.accountant-language-switcher button{min-width:40px;border:0;padding:9px 10px;background:transparent;color:var(--blue-deep);font:800 12px/1 system-ui,sans-serif;cursor:pointer}.accountant-language-switcher button.is-active{background:var(--blue-deep);color:#fff}.accountant-language-switcher button:focus-visible{outline:3px solid var(--orange);outline-offset:-3px}';
  document.head.append(style);
  addSwitcher();
  new MutationObserver((records) => {
    if (language !== 'zh') return;
    records.forEach((record) => record.addedNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) translateText(node);
      else if (node.nodeType === Node.ELEMENT_NODE && !node.closest?.('.accountant-language-switcher')) translateElement(node);
    }));
  }).observe(document.body, { childList: true, subtree: true });
})();
