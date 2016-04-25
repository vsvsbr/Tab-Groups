// VERSION 1.1.0

this.__defineGetter__('gBrowser', function() { return window.gBrowser; });
this.__defineGetter__('gTabViewDeck', function() { return $('tab-view-deck'); });
this.__defineGetter__('gTaskbarTabGroup', function() { return window.gTaskbarTabGroup; });
this.__defineGetter__('TabContextMenu', function() { return window.TabContextMenu; });
this.__defineGetter__('goUpdateCommand', function() { return window.goUpdateCommand; });

XPCOMUtils.defineLazyGetter(this, "AeroPeek", () => { return Cu.import("resource:///modules/WindowsPreviewPerTab.jsm", {}).AeroPeek; });
XPCOMUtils.defineLazyModuleGetter(this, "gPageThumbnails", "resource://gre/modules/PageThumbs.jsm", "PageThumbs");

this.TabView = {
	_deck: null,
	_iframe: null,
	_window: null,
	_initialized: false,
	_closedLastVisibleTabBeforeFrameInitialized: false,
	_isFrameLoading: false,

	_initFrameCallbacks: [],

	kButtonId: objName+'-tabview-button',
	kTooltipId: objName+'-tab-view-tooltip',
	kTabMenuPopupId: objName+'-context_tabViewMenuPopup',
	kInputContextMenuId: objName+'-tabview-context-input',
	kTabContextMenuId: 'tabContextMenu',
	get button() { return $(this.kButtonId); },
	get tooltip() { return $(this.kTooltipId); },
	get tabMenuPopup() { return $(this.kTabMenuPopupId); },
	get inputContextMenu() { return $(this.kInputContextMenuId); },
	get tabContextMenu() { return $(this.kTabContextMenuId); },

	// compatibility shims, for other add-ons to interact with this object more closely to the original if needed
	PREF_BRANCH: "extensions."+objPathString,
	PREF_RESTORE_ENABLED_ONCE: "extensions."+objPathString+".pageAutoChanged",
	PREF_STARTUP_PAGE: "browser.startup.page",
	get GROUPS_IDENTIFIER() { return Storage.kGroupsIdentifier; },
	get VISIBILITY_IDENTIFIER() { return ""; },
	get firstUseExperienced() { return true; },
	set firstUseExperienced(v) { return true; },
	get sessionRestoreEnabledOnce() { return Prefs.pageAutoChanged; },
	set sessionRestoreEnabledOnce(v) { return Prefs.pageAutoChanged = v; },
	get _browserKeyHandlerInitialized() { return true; },
	getContentWindow: function() { return this._window; },

	get windowTitle() {
		delete this.windowTitle;
		let brandBundle = $("bundle_brand");
		let brandShortName = brandBundle.getString("brandShortName");
		let title = Strings.get("TabView", "windowTitle", [ [ '$app', brandShortName ] ]);
		return this.windowTitle = title;
	},

	handleEvent: function(e) {
		switch(e.type) {
			case 'DOMContentLoaded':
				Listeners.remove(this._iframe, 'DOMContentLoaded', this);
				Listeners.add(this._iframe.contentWindow, "tabviewframeinitialized", this);

				prepareObject(this._iframe.contentWindow);
				this._iframe.contentWindow[objName].Modules.load('TabView-frame');
				break;

			case 'tabviewframeinitialized':
				Listeners.remove(this._iframe.contentWindow, 'tabviewframeinitialized', this);

				this._isFrameLoading = false;
				this._window = this._iframe.contentWindow;

				Tabs.unlisten("TabShow", this);
				Tabs.unlisten("TabClose", this);

				this._initFrameCallbacks.forEach(cb => cb());
				this._initFrameCallbacks = [];

				break;

			case 'TabShow':
				// if a tab is changed from hidden to unhidden and the iframe is not initialized, load the iframe and setup the tab.
				if(!this._window) {
					this._initFrame(() => {
						this._window[objName].UI.onTabSelect(Tabs.selected);
						if(this._closedLastVisibleTabBeforeFrameInitialized) {
							this._closedLastVisibleTabBeforeFrameInitialized = false;
							this._window[objName].UI.showTabView(false);
						}
					});
				}

				break;

			case 'TabClose':
				if(!this._window && !Tabs.visible.length) {
					this._closedLastVisibleTabBeforeFrameInitialized = true;
				}
				break;

			case 'popupshowing':
				switch(e.target.id) {
					// for the tooltip
					case this.kTooltipId:
						if(!this.fillInTooltip(document.tooltipNode)) {
							e.preventDefault();
							e.stopPropagation();
						}
						break;

					// On "move to group" popup showing.
					case this.kTabMenuPopupId:
						// Update the context menu only if Panorama was already initialized or if there are hidden tabs.
						if(this._window || Tabs.hasHidden()) {
							this.updateContextMenu(TabContextMenu.contextTab, e.target);
						}

					// Hide "Move to Group" in tabs context menu if it's a pinned tab.
					case 'tabContextMenu':
						$(objName+"-context_tabViewMenu").hidden = TabContextMenu.contextTab.pinned;
						break;
				}
				break;

			case 'tabviewshown':
				gTaskbarTabGroup.enabled = false;
				break;

			case 'tabviewhidden':
				gTaskbarTabGroup.enabled = AeroPeek.enabled;
				this.updateAeroPeek();
				break;
		}
	},

	observe: function(aSubject, aTopic, aData) {
		switch(aTopic) {
			case objName+'-set-groups-defaults':
				this._initFrame(() => {
					this._window[objName].GroupItems.resetGroupsOptions();
				});
				break;

			case 'nsPref:changed':
				this.toggleQuickAccess();
				break;
		}
	},

	onWidgetAdded: function(aWidgetId) {
		if(aWidgetId == this.kButtonId) {
			this.setButtonTooltip();
		}
	},

	onWidgetRemoved: function(aWidgetId) {
		if(aWidgetId == this.kButtonId) {
			this.setButtonTooltip();
		}
	},

	onAreaNodeRegistered: function() {
		this.setButtonTooltip();
	},

	onAreaNodeUnregstered: function() {
		this.setButtonTooltip();
	},

	init: function(loaded) {
		// ignore everything if this was called by the native initializer, we need to wait for our overlay to finish loading
		if(!loaded) { return; }

		if(!window.toolbar.visible || this._initialized) { return; }

		try {
			data = SessionStore.getWindowValue(window, Storage.kGroupsIdentifier);
			if(data) {
				data = JSON.parse(data);
				this.updateGroupNumberBroadcaster(data.totalNumber || 1);
			}
		}
		catch(ex) {}

		Listeners.add(this.tooltip, "popupshowing", this, true);
		Listeners.add(this.tabMenuPopup, "popupshowing", this);
		Listeners.add($('tabContextMenu'), "popupshowing", this);
		Tabs.listen("TabShow", this);
		Tabs.listen("TabClose", this);
		Observers.add(this, objName+'-set-groups-defaults');

		// Check if we should initialize the quick access panel, there's no point in doing it if it will never be used.
		CustomizableUI.addListener(this);
		Prefs.listen('quickAccessButton', this);
		Prefs.listen('quickAccessKeycode', this);
		this.toggleQuickAccess();

		// prevent thumbnail service from expiring thumbnails
		// we can't wait for the panel view here since expiration may run before it is initialized
		gPageThumbnails.addExpirationFilter(this);

		Piggyback.add('TabView', window, 'WindowIsClosing', () => {
			if(this.hide()) {
				return false;
			}
			return window._WindowIsClosing();
		});

		Piggyback.add('TabView', window, 'undoCloseTab', (aIndex) => {
			let tab = null;
			if(SessionStore.getClosedTabCount(window) > (aIndex || 0)) {
				// wallpaper patch to prevent an unnecessary blank tab (bug 343895)
				let blankTabToRemove = null;
				if(Tabs.length == 1 && window.isTabEmpty(Tabs.selected)) {
					blankTabToRemove = Tabs.selected;
				}

				this.prepareUndoCloseTab(blankTabToRemove);
				tab = SessionStore.undoCloseTab(window, aIndex || 0);
				this.afterUndoCloseTab();

				if(blankTabToRemove) {
					gBrowser.removeTab(blankTabToRemove);
				}
			}

			return tab;
		});

		Piggyback.add('TabView', gBrowser, 'updateTitlebar', () => {
			if(this.isVisible()) {
				document.title = this.windowTitle;
				return false;
			}
			return true;
		}, Piggyback.MODE_BEFORE);

		if(gTaskbarTabGroup) {
			Listeners.add(window, 'tabviewshown', this);
			Listeners.add(window, 'tabviewhidden', this);

			Piggyback.add('TabView', gTaskbarTabGroup, 'newTab', function(tab) {
				// Only add tabs to the taskbar preview area if they belong to the current group.
				return !tab.hidden;
			}, Piggyback.MODE_BEFORE);

			Piggyback.add('TabView', gTaskbarTabGroup, 'removeTab', function(tab) {
				// Not all tabs are being handled, make sure it won't freak out because of this.
				return this.previews.has(tab);
			}, Piggyback.MODE_BEFORE);

			// Make sure only tabs from the current group are displayed in the aero peek on startup.
			this.updateAeroPeek();
		}

		this._initialized = true;

		// When updating from a 1.0.* version while tab view is visible, it wouldn't successfully hide it before deinitializing it.
		// So we need to make sure that happens now, otherwise the user can't do a thing.
		if(!gTabViewDeck.selectedPanel) {
			this._initFrame(() => {
				gTabViewDeck.selectedPanel = this._iframe;
				this.hide();
			});
		}
	},

	uninit: function() {
		if(!this._initialized) { return; }

		if(gTaskbarTabGroup) {
			Piggyback.revert('TabView', gTaskbarTabGroup, 'newTab');
			Piggyback.revert('TabView', gTaskbarTabGroup, 'removeTab');

			Listeners.remove(window, 'tabviewshown', this);
			Listeners.remove(window, 'tabviewhidden', this);
		}

		gPageThumbnails.removeExpirationFilter(this);

		Piggyback.revert('TabView', window, 'WindowIsClosing');
		Piggyback.revert('TabView', window, 'undoCloseTab');
		Piggyback.revert('TabView', gBrowser, 'updateTitlebar');

		CustomizableUI.removeListener(this);
		Prefs.unlisten('quickAccessButton', this);
		Prefs.unlisten('quickAccessKeycode', this);
		Modules.unload('quickAccess');

		Listeners.remove(this.tooltip, "popupshowing", this, true);
		Listeners.remove(this.tabMenuPopup, "popupshowing", this);
		Listeners.remove($('tabContextMenu'), "popupshowing", this);
		Tabs.unlisten("TabShow", this);
		Tabs.unlisten("TabClose", this);
		Observers.remove(this, objName+'-set-groups-defaults');

		this._initialized = false;
		this._deinitFrame();
	},

	filterForThumbnailExpiration() {
		return Tabs.all.map(t => t.linkedBrowser.currentURI.spec);
	},

	// Creates the frame and calls the callback once it's loaded. If the frame already exists, calls the callback immediately.
	_initFrame: function(callback) {
		// prevent frame to be initialized for popup windows
		if(!window.toolbar.visible) { return; }

		if(this._window) {
			if(callback) {
				callback();
			}
			return;
		}

		if(callback) {
			this._initFrameCallbacks.push(callback);
		}

		if(this._isFrameLoading) { return; }
		this._isFrameLoading = true;

		// find the deck
		this._deck = gTabViewDeck;

		// create the frame
		this._iframe = document.createElement("iframe");
		this._iframe.id = objName+"-tab-view";
		this._iframe.setAttribute("transparent", "true");
		this._iframe.setAttribute("tooltip", this.kTooltipId);
		this._iframe.flex = 1;

		Listeners.add(this._iframe, "DOMContentLoaded", this);

		this._iframe.setAttribute("src", "chrome://"+objPathString+"/content/tabview.xhtml");
		this._deck.appendChild(this._iframe);
	},

	_deinitFrame: function() {
		// nothing to do
		if(!this._window && !this._iframe && !this._deck) { return; }

		// hide() will actually fail to complete properly if this method is called while tab view is visible,
		// because it implies a degree of asynchronicity in the process.
		// So we force tab view to disappear in that case, to make sure the user isn't left with a blank empty window.
		this.hide(true);

		Listeners.remove(this._window, "tabviewframeinitialized", this);
		Listeners.remove(this._iframe, "DOMContentLoaded", this);

		if(this._initialized) {
			Tabs.listen("TabShow", this);
			Tabs.listen("TabClose", this);
		}

		this._deck = null;

		if(this._window) {
			removeObject(this._window);
			this._window = null;
		}

		if(this._iframe) {
			this._iframe.remove();
			this._iframe = null;
		}
	},

	isVisible: function() {
		return (this._deck ? this._deck.selectedPanel == this._iframe : false);
	},

	show: function() {
		if(this.isVisible()) { return; }

		// Make sure the quick access panel is hidden if we enter tab view
		if(self.quickAccess) {
			quickAccess.hide();
		}

		this._initFrame(() => {
			this._window[objName].UI.showTabView(true);
		});
	},

	hide: function(force) {
		if(this.isVisible() && this._window) {
			this._window[objName].UI.exit();
			if(force) {
				this._window[objName].UI.hideTabView();
			}
			return true;
		}
		return false;
	},

	toggle: function() {
		if(!window.toolbar.visible) { return; }

		if(this.isVisible()) {
			this.hide();
		} else {
			this.show();
		}
	},

	commandButton: function() {
		if(Prefs.quickAccessButton && self.quickAccess) {
			quickAccess.toggle();
			return;
		}
		this.toggle();
	},

	switchGroup: function(aPrevious) {
		if(!Tabs.hasHidden()) { return; }

		this._initFrame(() => {
			let groupItems = this._window[objName].GroupItems;
			let tabItem = groupItems.getNextGroupItemTab(aPrevious);
			if(!tabItem) { return; }

			let isVisible = this.isVisible();
			if(Tabs.selected.pinned || isVisible) {
				groupItems.updateActiveGroupItemAndTabBar(tabItem, { dontSetActiveTabInGroup: !isVisible });
			} else {
				Tabs.selected = tabItem.tab;
			}
		});
	},

	updateContextMenu: function(tab, popup) {
		let separator = $(objName+"-context_tabViewNamedGroups");
		separator.hidden = true;

		// empty the menu immediately so old and invalid entries aren't shown
		this.emptyContextMenu(popup, separator);

		this._initFrame(() => {
			// empty the menu again because sometimes this is called twice (on first open, don't know why though), leading to double entries
			this.emptyContextMenu(popup, separator);

			let activeGroup = tab._tabViewTabItem.parent;
			let groupItems = this._window[objName].GroupItems;
			let menuItems = [];

			for(let groupItem of groupItems) {
				// it's not hidden and there is no active group or the active group id doesn't match the group id,
				// a group menu item will be added.
				if(!groupItem.hidden
				&& (!activeGroup || activeGroup.id != groupItem.id)) {
					menuItems.push(this._createGroupMenuItem(groupItem));
				}
			}

			if(menuItems.length) {
				menuItems.sort(function(a, b) {
					if(a.groupTitle < b.groupTitle) { return -1; }
					if(a.groupTitle > b.groupTitle) { return 1; }
					return 0;
				});
				for(let menuItem of menuItems) {
					popup.insertBefore(menuItem, separator);
				}
				separator.hidden = false;
			}
		});
	},

	emptyContextMenu: function(popup, separator) {
		while(popup.firstChild && popup.firstChild != separator) {
			popup.firstChild.remove();
		}
	},

	getGroupTitle: function(groupItem) {
		return groupItem.getTitle(true).trim();
	},

	_createGroupMenuItem: function(groupItem) {
		let menuItem = document.createElement("menuitem");
		let title = this.getGroupTitle(groupItem);

		menuItem.groupId = groupItem.id;
		menuItem.groupTitle = title;
		menuItem.setAttribute("label", title);
		menuItem.setAttribute("tooltiptext", title);
		menuItem.setAttribute("crop", "center");
		menuItem.setAttribute("class", "tabview-menuitem");

		menuItem.handleEvent = (e) => {
			this.moveTabTo(TabContextMenu.contextTab, menuItem.groupId);
		};
		menuItem.addEventListener("command", menuItem);

		return menuItem;
	},

	openInputContextMenu: function(e) {
		// Update the relevant commands, so that the corresponding menu entries are enabled or disabled as appropriate.
		goUpdateCommand("cmd_undo");
		goUpdateCommand("cmd_redo");
		goUpdateCommand("cmd_cut");
		goUpdateCommand("cmd_copy");
		goUpdateCommand("cmd_paste");
		goUpdateCommand("cmd_selectAll");
		goUpdateCommand("cmd_delete");

		this.inputContextMenu.openPopupAtScreen(e.screenX, e.screenY, true);
	},

	openTabContextMenu: function(e, tab, anchor) {
		// The tab context menu is constructed based on the triggerNode property of the original event.
		// Because we're in tabview, the triggerNode cannot actually be the tab itself, so we fake it here
		// to avoid having to replace that whole handler just to open the popup correctly.
		let fakeEvent = new window.MouseEvent('click', {
			view: window,
			bubbles: false,
			cancelable: false,
			button: -1,
			buttons: 0
		});
		tab.dispatchEvent(fakeEvent);

		if(!e.button) {
			this.tabContextMenu.openPopup(anchor, 'end_before', 0, 0, true, false, fakeEvent);
		} else {
			this.tabContextMenu.openPopup(null, 'after_pointer', e.clientX +1, e.clientY +1, true, false, fakeEvent);
		}
	},

	moveTabTo: function(tab, groupItemId, focusIfSelected) {
		this._initFrame(() => {
			this._window[objName].GroupItems.moveTabToGroupItem(tab, groupItemId, focusIfSelected);
		});
	},

	// Prepares the tab view for undo close tab.
	prepareUndoCloseTab: function(blankTabToRemove) {
		if(this._window) {
			this._window[objName].UI.restoredClosedTab = true;

			if(blankTabToRemove && blankTabToRemove._tabViewTabItem) {
				blankTabToRemove._tabViewTabItem.isRemovedAfterRestore = true;
			}
		}
	},

	// Cleans up the tab view after undo close tab.
	afterUndoCloseTab: function() {
		if(this._window) {
			this._window[objName].UI.restoredClosedTab = false;
		}
	},

	// Updates the group number broadcaster.
	updateGroupNumberBroadcaster: function(number) {
		let groupsNumber = $(objName+"-tabviewGroupsNumber");
		setAttribute(groupsNumber, "groups", number);
	},

	// Fills in the tooltip text.
	fillInTooltip: function(tipElement) {
		let titleText = null;
		let direction = tipElement.ownerDocument.dir;

		while(!titleText && tipElement) {
			if(tipElement.nodeType == window.Node.ELEMENT_NODE) {
				titleText = tipElement.getAttribute("title");
			}
			tipElement = tipElement.parentNode;
		}

		this.tooltip.style.direction = direction;

		if(titleText) {
			setAttribute(this.tooltip, "label", titleText);
			return true;
		}

		return false;
	},

	// With Aero Peek enabled, it should only peek tabs of the current group.
	updateAeroPeek: function() {
		if(!gTaskbarTabGroup) { return; }
		let changed = false;

		// First we eliminate all preview thumbs from tabs not in the current group.
		for(let tab of gTaskbarTabGroup.previews.keys()) {
			if(tab.hidden) {
				gTaskbarTabGroup.removeTab(tab);
				changed = true;
			}
		}

		// Next we add thumbs from tabs in the current group that aren't already tracked.
		for(let tab of Tabs.visible) {
			if(!gTaskbarTabGroup.previews.has(tab)) {
				gTaskbarTabGroup.newTab(tab);
				changed = true;
			}
		}

		if(changed) {
			// We make sure the thumbs are shown in the correct order.
			gTaskbarTabGroup.updateTabOrdering();

			// And if previews should even be shown at all.
			AeroPeek.checkPreviewCount();
		}
	},

	toggleQuickAccess: function() {
		this.setButtonTooltip();
		Modules.loadIf('quickAccess', Prefs.quickAccessButton || Prefs.quickAccessKeycode != 'none');
	},

	setButtonTooltip: function() {
		let button = this.button;
		if(button) {
			let name = (Prefs.quickAccessButton) ? 'buttonQuickAccessTooltip' : 'buttonManageTooltip';
			let tooltip = Strings.get('TabView', name);
			setAttribute(button, 'tooltiptext', tooltip);
		}
	},

	goToPreferences: function(aOptions) {
		if(self.quickAccess) {
			quickAccess.hide();
		}
		PrefPanes.open(window, aOptions);
	},

	onLoad: function() {
		migrate.migrateWidget();

		window.SessionStore.promiseInitialized.then(() => {
			if(UNLOADED) { return; }

			this.init(true);
		});
	},

	onUnload: function() {
		this.uninit();
	}
};

Modules.LOADMODULE = function() {
	// compatibility shim, for other add-ons to interact with this object more closely to the original if needed
	window.TabView = TabView;

	Modules.load('AllTabs');
	Modules.load('CatchRules');
	Overlays.overlayWindow(window, 'TabView', TabView);
};

Modules.UNLOADMODULE = function() {
	Overlays.removeOverlayWindow(window, 'TabView');
	Modules.unload('CatchRules');
	Modules.unload('AllTabs');

	delete window.TabView;
};
