/*
 * Copyright 2023 Diego Povliuk
 * SPDX-License-Identifier: GPL-3.0-only
 */

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import { Medication, HistoryMedication, TodayMedication } from './medication.js';
import { todayHeaderFactory, todayItemFactory } from './todayFactory.js';
import { historyHeaderFactory, historyItemFactory } from './historyFactory.js';
import { treatmentsFactory } from './treatmentsFactory.js';

import {
	AtoZSorter,	HistorySectionSorter, HistorySorter, TodaySectionSorter,
	DataDir, addLeadZero, doseRow, getTimeBtnInput, formatDate,
	createTempFile, handleCalendarSelect, isMedDay, dateDifference, 
} from './utils.js';

const historyLS = Gio.ListStore.new(HistoryMedication);
const treatmentsLS = Gio.ListStore.new(Medication);

export const DosageWindow = GObject.registerClass({
	GTypeName: 'DosageWindow',
	Template: 'resource:///com/github/diegopvlk/Dosage/ui/window.ui',
	InternalChildren: [
		'todayList', 'historyList', 'treatmentsList', 'treatmentsPage',
		'skipBtn', 'entryBtn', 'unselectBtn', 
		'emptyToday', 'emptyHistory', 'emptyTreatments'
	],
},
class DosageWindow extends Adw.ApplicationWindow {
	constructor(application) {
		super({ application });
		this.#loadSettings();
		this.#checkClockFormat();
		this.#start();
		this.#checkInventory();
		this.#scheduleNextMidnight();
	}

	#loadSettings() {
		const appId = this.get_application().applicationId;
		globalThis.settings = new Gio.Settings({ schemaId: appId });
		settings.bind('window-width', this, 'default-width', Gio.SettingsBindFlags.DEFAULT);
		settings.bind('window-height', this, 'default-height', Gio.SettingsBindFlags.DEFAULT);
	}

	#checkClockFormat() {
		const currentTime = GLib.DateTime.new_now_local();
		const timeFormat = currentTime.format('%X').slice(-2);
		globalThis.clockIs12 = timeFormat === 'AM' || timeFormat === 'PM';
	}
	
	#start() {
		const treatmentsFile = DataDir.get_child('dosage-treatments.json');
		const historyFile = DataDir.get_child('dosage-history.json');

		this._createLoadJsonFile('treatments', treatmentsFile);
		this._createLoadJsonFile('history', historyFile);

		try {
			this._loadTreatments();
			this._loadHistory();
			this._loadToday();
		} catch (err) {
			console.error('Error loading treatments/history/today... ', err);
		}

		// set backdrop to send background notifications
		this.connect('hide', () => this.set_state_flags(Gtk.StateFlags.BACKDROP, true));
	}

	#checkInventory() {
		const app = this.get_application();
		const notification = new Gio.Notification();
		const priorityState = settings.get_boolean('priority');
		const priority = priorityState
			? Gio.NotificationPriority.URGENT
			: Gio.NotificationPriority.NORMAL;
		notification.set_priority(priority);

		notification.set_title(_("Dosage reminder"));
		notification.set_body(_("You have treatments low in stock"));

		this._treatmentsPage.set_needs_attention(false);

		let count = 0;
		for (const item of treatmentsLS) {
			const inv = item.info.inventory;
			if (inv.enabled && inv.current <= inv.reminder) {
				count++;
				this._treatmentsPage.set_needs_attention(true);
				this._treatmentsPage.badge_number = count;

				if (!this.get_visible())
					app.send_notification('low-stock', notification);	
			}
		}
	}

	#scheduleNextMidnight() {
		const now = new Date();
		const midnight = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate() + 1, // next day at midnight
			0, 0, 0, // hours, minutes, seconds
		);

		const timeUntilMidnight = midnight - now;

		setTimeout(() => {
			this._addMissedItems();
			this._updateEverything();
			this.#checkInventory();
			this.#scheduleNextMidnight();
		}, timeUntilMidnight);
	}

	_createLoadJsonFile(fileType, file) {
		const filePath = file.get_path();
	
		if (!file.query_exists(null)) {
			try {
				this._createNewFile(filePath);
				log(`New ${fileType} file created at: ${filePath}`);
			} catch (err) {
				console.error(`Failed to create new ${fileType} file... ${err}`);
			}
		}

		try {
			this._loadJsonContents(fileType, filePath);
		} catch (err) {
			console.error(`Failed to load ${fileType} contents... ${err}`);
		}
	}

	_createNewFile(filePath) {
		const file = Gio.File.new_for_path(filePath);
		const flags = Gio.FileCreateFlags.NONE;
		const fileStream = file.create(flags, null);

		if (!fileStream)
			throw new Error("Failed to create the file:", filePath);

		const outputStream = new Gio.DataOutputStream({ base_stream: fileStream });
		outputStream.put_string('{"meds":[]}', null);

		outputStream.close(null);
		fileStream.close(null);
	}

	_loadJsonContents(fileType, filePath) {
		const file = Gio.File.new_for_path(filePath);
		const decoder = new TextDecoder('utf8');

		try {
			let [success, contents, length] = file.load_contents(null);

			if (success) {
				const contentString = decoder.decode(contents);
				if (fileType === 'treatments') {
					this._treatmentsJson = JSON.parse(contentString);
				} else if (fileType === 'history') {
					this._historyJson = JSON.parse(contentString);
				}
			} else {
				log("Failed to read file contents.");
			}
		} catch (err) {
			console.error(`Error reading the file ${fileType}... ${err.message}`);
		}
	}

	_loadTreatments() {	
		try {
			if (treatmentsLS.get_n_items() === 0) {
				this._treatmentsJson.meds.forEach(med => {
					treatmentsLS.append(
						new Medication({
							name: med._name,
							unit: med._unit,
							info: med._info,
						})
					);
				});	
			}
		} catch (err) {
			console.error('Error loading treatments...', err)
		}

		this._sortedTreatmentsModel = new Gtk.SortListModel({
			model: treatmentsLS,
			sorter: new AtoZSorter(),
		});

		this._treatmentsModel = new Gtk.NoSelection({
			model: this._sortedTreatmentsModel,
		});

		this._treatmentsList.model = this._treatmentsModel;

		this._treatmentsList.remove_css_class('view');
		this._treatmentsList.add_css_class('background');

		this._treatmentsList.set_factory(treatmentsFactory);
	}

	_loadHistory() {
		try {
			if (historyLS.get_n_items() === 0) {
				this._historyJson.meds.forEach(med => {
					historyLS.append(
						new HistoryMedication({
							name: med._name,
							unit: med._unit,
							color: med._color,
							info: med._info,
							taken: med._taken,
							date: med._date,
						})
					);
				});
			}
		} catch (err) {
			console.error('Error loading history...', err)
		}

		try {
			this._sortedHistoryModel = new Gtk.SortListModel({
				model: historyLS,
				section_sorter: new HistorySectionSorter(),
				sorter: new HistorySorter(),
			});
	
			this._historyModel = new Gtk.NoSelection({
				model: this._sortedHistoryModel,
			});

			this._addMissedItems();
	
			this._historyList.model = this._historyModel;
	
			this._historyList.remove_css_class('view');
			this._historyList.add_css_class('background');
	
			this._historyList.set_header_factory(historyHeaderFactory);
			this._historyList.set_factory(historyItemFactory);
			
			historyLS.connect('items-changed', (model, pos, removed, added) => {
				if (added) {
					const itemAdded = model.get_item(pos);
					for (const item of treatmentsLS) {
						if (
							item.name === itemAdded.name &&
							item.info.inventory.enabled &&
							itemAdded.taken === "yes"
						) {
							item.info.inventory.current -= itemAdded.info.dose;
						}
					}
				}

				if (removed) {
					const itemRmDt = new Date(itemRemoved.date);
					const date = formatDate(itemRmDt);
					const today = formatDate(new Date());

					if (date === today) {
						for (const item of treatmentsLS) {
							if (
								item.name === itemRemoved.name &&
								item.info.inventory.enabled &&
								itemRemoved.taken === 'yes'
							) {
								item.info.inventory.current += itemRemoved.info.dose;
							}
						}
					}

					this._updateEverything();
				}				
			});
		} catch (err) {
			console.error("_loadHistory error... ", err)
		}

		this._setEmptyHistLabel();
	}

	_loadToday() {
		const todayLS = Gio.ListStore.new(TodayMedication);
		const tempFile = createTempFile(treatmentsLS);
		const todayDate = new Date();

		tempFile.meds.forEach(med => {
			med._info.dosage.forEach(timeDose => {
				const info = { ...med._info, updated: undefined };
				info.dosage = {
					time: [timeDose.time[0], timeDose.time[1]],
					dose: timeDose.dose,
				};
				todayLS.append(
					new TodayMedication({
						name: med._name,
						unit: med._unit,
						info: info,
					})
				);
			});
		})

		this._filterTodayModel = new Gtk.FilterListModel({
			model: todayLS,
			filter: Gtk.CustomFilter.new(item => {
				return isMedDay(
					item, 
					todayDate, 
					true, 
					this._historyModel,
					this._sortedHistoryModel
				)
			}),
		});

		this._sortedTodayModel = new Gtk.SortListModel({
			model: this._filterTodayModel,
			section_sorter: new TodaySectionSorter(),
		});

		this._todayModel = new Gtk.NoSelection({ model: this._sortedTodayModel });

		this._todayList.model = this._todayModel;

		this._todayList.remove_css_class('view');
		this._todayList.add_css_class('background');

		this._todayList.set_header_factory(todayHeaderFactory);
		this._todayList.set_factory(todayItemFactory);

		this._todayItems = [];

		const todayLength = this._todayModel.get_n_items();
		for (let i = 0; i < todayLength; i++)
			this._addToBeNotified(this._todayModel.get_item(i));
			
		const noItems = this._sortedTodayModel.get_n_items() === 0;
		const noTreatments = this._sortedTreatmentsModel.get_n_items() === 0;

		this._emptyTreatments.ellipsize = Pango.EllipsizeMode.END;
		this._emptyToday.ellipsize = Pango.EllipsizeMode.END;
		
		this._emptyTreatments.set_visible(noTreatments);

		if (noItems && noTreatments) {
			this._emptyToday.set_visible(true);
			this._emptyToday.label = _("No treatments added yet!");
		} else if (noItems) {
			this._emptyToday.set_visible(true);
			this._emptyToday.label = _("All done for today!");
		} else {		
			this._emptyToday.set_visible(false);
		}
	}

	_addToBeNotified(item) {
		const now = new Date();
		const hours = now.getHours();
		const minutes = now.getMinutes();
		const seconds = now.getSeconds();
		const itemHour = item.info.dosage.time[0];
		const itemMin = item.info.dosage.time[1];
		const app = this.get_application();
		const notifyItem = { name: item.name, dosage: item.info.dosage };
		const pseudoId = JSON.stringify(notifyItem);
		const notification = new Gio.Notification();
		const priorityState = settings.get_boolean('priority');
		const priority = priorityState
			? Gio.NotificationPriority.URGENT
			: Gio.NotificationPriority.NORMAL;
		notification.set_priority(priority);

		// milliseconds
		let timeDifference =
			(itemHour - hours) * 3600000 +
			(itemMin - minutes) * 60000 - (seconds * 1000);
		
		setTimeout(() => {
			notification.set_title(_("Dosage reminder"));
			notification.set_body(
				`${item.name}  ⦁  ${item.info.dosage.dose} ${item.unit}`
			);

			/* 
			using backdrop instead of .is_active, because .is_active is false 
			if there is a modal showing and true after the window closes
			and for some reason .is_suspended always returns false
			*/
			let stateFlags = this.get_state_flags();
			if (stateFlags & Gtk.StateFlags.BACKDROP)
				app.send_notification(`${pseudoId}`, notification);
		}, timeDifference);
	}

	_selectTodayItems(list, position) {
		const model = list.get_model();

		let rowItemPos = 0;
		let currentRow = list.get_first_child();

		while (currentRow) {
			if (currentRow.get_name() === 'GtkListItemWidget') {
				if (position === rowItemPos) {
					const topBox = currentRow.get_first_child();
					const labelsBox = topBox.get_first_child().get_next_sibling();
					const check = labelsBox.get_next_sibling().get_next_sibling();
					const item = model.get_item(position);
					const index = this._todayItems.lastIndexOf(item);

					if (check.get_active() === false)
						this._todayItems.push(item);
					else
						this._todayItems.splice(index, 1);

					check.set_active(!check.get_active());
				}
				rowItemPos++;
			}
			currentRow = currentRow.get_next_sibling();
		}

		this._unselectBtn.connect('clicked', () => {
			let currentRow = list.get_first_child();
			
			while (currentRow) {
				if (currentRow.get_name() === 'GtkListItemWidget') {
					const topBox = currentRow.get_first_child();
					const labelsBox = topBox.get_first_child().get_next_sibling();
					const check = labelsBox.get_next_sibling().get_next_sibling();
					check.set_active(false);
				}
				currentRow = currentRow.get_next_sibling();
			}
			this._updateEntryBtn(false);
		});
		
		const hasTodayItems = this._todayItems.length > 0;
		this._updateEntryBtn(hasTodayItems);
	}

	_updateEntryBtn(hasTodayItems) {
		this._entryBtn.label = hasTodayItems ? _('Confirm') : _('One-time entry');
		this._skipBtn.set_visible(hasTodayItems);
		this._unselectBtn.set_visible(hasTodayItems);

		if (hasTodayItems) {
			this._entryBtn.add_css_class('suggested-action');
		} else {
			this._entryBtn.remove_css_class('suggested-action');
			this._todayItems = [];
		}
	}

	_addToHistory(btn) {
		const taken = btn.get_name(); // yes or no

		if (this._todayItems.length > 0) {
			this._todayItems.forEach(item => {
				historyLS.append(
					new HistoryMedication({
						name: item.name,
						unit: item.unit,
						color: item.info.color,
						taken: taken,
						info: item.info.dosage,
						date: new Date().toJSON(),
					})
				);
			});

			// also update the date of treatments for each dose taken/skipped
			for (const item of treatmentsLS) {
				item.info.dosage.forEach(timeDose => {
					const tempObj = { ...timeDose, updated: undefined };
					const treatDose = JSON.stringify(tempObj);
					this._todayItems.forEach((i) => {
						const todayDose = JSON.stringify(i.info.dosage);
						if (treatDose === todayDose)
							timeDose.updated = new Date().toJSON();
					});	
				});
			}

			this._updateEverything();
		} 
		else {
			log('one-time entry')
			this._openMedWindow(null, null, true)
		}

		this._updateEntryBtn(false);
	}

	_addMissedItems() {
		let itemsAdded = false;

		try {		
			for (const item of treatmentsLS) {
				item.info.dosage.forEach(timeDose => {
					const dateLastUp = new Date(timeDose.updated);
					dateLastUp.setDate(dateLastUp.getDate() + 1);		
					const today = formatDate(new Date());
					const lastUpdated = formatDate(dateLastUp);

					if (lastUpdated < today) {
						const datesPassed = dateDifference(lastUpdated, today);
						datesPassed.forEach(date => {	
							if (
								new Date(date) < new Date() &&
								new Date(date) > dateLastUp &&
								isMedDay(item, date)
							) {
								const info = {
									time: [timeDose.time[0], timeDose.time[1]],
									dose: timeDose.dose
								};
								historyLS.append(
									new HistoryMedication({
										name: item.name,
										unit: item.unit,
										color: item.info.color,
										taken: 'miss',
										info: info,
										date: date.toJSON(),
									})
								);
								itemsAdded = true;
							}
						});
					}
					timeDose.updated = new Date().toJSON();
				});
			}
		} catch (err) {
			console.error('Error adding missed items...', err)
		}
		
		this._updateJsonFile('treatments', treatmentsLS);

		if (itemsAdded) {
			this._updateJsonFile('history', historyLS);
			this._updateEntryBtn(false);
		}
	}

	_updateJsonFile(type, listStore) {
		const fileName = `dosage-${type}.json`
		const file = DataDir.get_child(fileName);
		const tempFile = createTempFile(listStore);

		try {
			file.replace_contents(
				JSON.stringify(tempFile),
				null,
				false,
				Gio.FileCreateFlags.REPLACE_DESTINATION,
				null
			);
			log(`${fileName} updated`);
		} catch (err) {
			console.error(`Update of ${fileName} file failed... ${err}`);
		}
	}

	_updateEverything() {
		this._updateJsonFile('history', historyLS);
		this._updateJsonFile('treatments', treatmentsLS);
		this._loadTreatments();
		this._loadToday();
		this._setEmptyHistLabel();
		this._updateEntryBtn(false);
		this.#checkInventory();
	}

	_setEmptyHistLabel() {
		this._emptyHistory.ellipsize = Pango.EllipsizeMode.END;
		if (historyLS.get_n_items() === 0)
			this._emptyHistory.set_visible(true);
		else
			this._emptyHistory.set_visible(false);
	}

	_openMedWindow(list, position, oneTime) {
		const builder = Gtk.Builder.new_from_resource(
			'/com/github/diegopvlk/Dosage/ui/med-window.ui'
		);
		const medWindow = builder.get_object('medWindow');
		medWindow.set_modal(true);
		medWindow.set_transient_for(this);
		
		const cancelButton = builder.get_object('cancelButton');
		const saveButton = builder.get_object('saveButton');
		const deleteButton = builder.get_object('deleteMedication');

		const medName = builder.get_object('name');
		const medUnit = builder.get_object('unit');
		const medNotes = builder.get_object('notes');

		const dosageColorButton = builder.get_object('dosageColorButton');
		const dosageIconButton = builder.get_object('dosageIconButton');
		const dosageColorBox = builder.get_object('dosageColorBox');
		const dosageIconBox = builder.get_object('dosageIconBox');

		for (const clr of dosageColorBox) {
			clr.connect('clicked', () => {
				dosageColorBox.get_parent().get_parent().popdown();
				const colors = dosageColorButton.get_css_classes();
				for (const c of colors) {
					if (c.includes('-clr'))
						dosageColorButton.remove_css_class(c);
				}
				dosageColorButton.add_css_class(clr.get_name() + '-clr')
				dosageColorButton.name = clr.get_name();
			});
		}
		for (const icn of dosageIconBox) {
			icn.connect('clicked', () => {
				dosageIconBox.get_parent().get_parent().popdown();
				dosageIconButton.set_icon_name(icn.get_icon_name());
			});
		}

		const frequencyMenu = builder.get_object('frequencyMenu');
		const frequencySpecificDays = builder.get_object('frequencySpecificDays');
		const freqChooseDaysLabel = frequencySpecificDays
			.get_first_child()
			.get_first_child()
			.get_first_child();
		freqChooseDaysLabel.ellipsize = Pango.EllipsizeMode.END;

		const frequencyCycle = builder.get_object('frequencyCycle');	
		const cycleActive = builder.get_object('cycleActive');
		const cycleInactive = builder.get_object('cycleInactive');
		const cycleCurrent = builder.get_object('cycleCurrent');

		const dosage = builder.get_object('dosage');
		dosage.set_expanded(true);
		const dosageAddButton = builder.get_object('dosageAddButton');
		const dosageHeader = dosage
			.get_first_child()
			.get_first_child()
			.get_first_child();
		const dosageExpanderButton = dosageHeader
			.get_first_child()
			.get_last_child();
		dosageHeader.set_activatable(false);
		dosageExpanderButton.set_visible(false);

		const medInventory = builder.get_object('inventory');
		const medCurrrentInv = builder.get_object('currentInventory');
		const medReminderInv = builder.get_object('reminderInventory');

		const medDuration = builder.get_object('duration');
		const calendarStart = builder.get_object('calendarStart');
		const calendarStartBtn = builder.get_object('calendarStartBtn');
		const calendarEnd = builder.get_object('calendarEnd');
		const calendarEndBtn = builder.get_object('calendarEndBtn');

		calendarStartBtn.label = GLib.DateTime.new_now_local().format('%x');
		calendarEndBtn.label = GLib.DateTime.new_now_local().format('%x');
		  
		handleCalendarSelect(calendarStart, calendarStartBtn);
		handleCalendarSelect(calendarEnd, calendarEndBtn);

		// when opening an existing treatment
		if (list && position >= 0) {
			medWindow.title = _("Edit treatment");
			saveButton.label = _("Save");
			deleteButton.set_visible(true);
			
			const item = list.get_model().get_item(position);
			const info = item.info;

			medName.text = item.name;
			medUnit.text = item.unit;
			medNotes.text = info.notes ? info.notes : "";
			
			for (const clr of dosageColorBox) {
				if (clr.get_name() === info.color) {
					dosageColorButton.add_css_class(info.color + '-clr');
					dosageColorButton.name = clr.get_name();
				}
			}
			for (const icn of dosageIconBox) {
				if (icn.get_icon_name() === info.icon)
					dosageIconButton.set_icon_name(info.icon)
			}

			setFreqMenuVisibility(item);

			info.dosage.forEach(timeDose => {
				dosage.add_row(doseRow(timeDose));
			});

			if (info.days && info.days.length !== 0) {
				const specificDaysBox = builder.get_object('specificDaysBox');

				let day = 0;
				for (const btn of specificDaysBox) {
					for (const d of info.days)
						if (d === day) btn.set_active(true);
					day++;
				}
			}

			if (info.cycle && info.cycle.length !== 0) {
				const [active, inactive, current] = info.cycle;
				
				cycleActive.value = active;
				cycleInactive.value = inactive;
				cycleCurrent.value = current;
				
				cycleCurrent.adjustment.set_upper(active + inactive);
				
				frequencyCycle.label = `${active}  ⊷  ${inactive}`;
			}

			if (info.inventory.enabled) {
				medInventory.set_enable_expansion(true);
			}
			medCurrrentInv.value = info.inventory.current;
			medReminderInv.value = info.inventory.reminder;

			if (info.duration.enabled) {
				medDuration.set_enable_expansion(true);

				// the parsing is in seconds
				const start = GLib.DateTime.new_from_unix_utc(item.info.duration.start);
				const end = GLib.DateTime.new_from_unix_utc(item.info.duration.end);

				calendarStart.select_day(start);
				calendarEnd.select_day(end);
			}
		}

		if (oneTime) {
			medWindow.title = _("New one-time entry");
			const frequency = builder.get_object('frequency');
			const colorIcon = builder.get_object('colorIcon');
			medWindow.add_css_class('one-time');
			colorIcon.title = _("Color");
			medNotes.set_visible(false);
			dosageIconButton.set_visible(false);
			frequency.set_visible(false);
			medDuration.set_visible(false);
			dosageAddButton.get_parent().get_parent().set_visible(false);
			
			medInventory.set_visible(false);
		}

		setFreqMenuVisibility();

		cycleActive.connect('output', () => {
			frequencyCycle.label =
				cycleActive.value + "  ⊷  " + cycleInactive.value;

			let sum = cycleActive.value + cycleInactive.value;	
			cycleCurrent.adjustment.set_upper(sum);
			if (cycleCurrent.adjustment.value > sum) {
				cycleCurrent.adjustment.value = sum;
			}
			
		});
		cycleInactive.connect('output', () => {
			frequencyCycle.label =
				cycleActive.value + "  ⊷  " + cycleInactive.value;

			let sum = cycleActive.value + cycleInactive.value;	
			cycleCurrent.adjustment.set_upper(sum);
			if (cycleCurrent.adjustment.value > sum) {
				cycleCurrent.adjustment.value = sum;
			}
		});

		let h = 13;
		dosageAddButton.connect('clicked', () => {
			if (h == 24) h = 0;
			dosage.add_row(doseRow({ time: [h++, 30], dose: 1 }));
		});
		

		const dosageBox = dosage.get_first_child();
		const listBox = dosageBox.get_first_child();
		const revealer = listBox.get_next_sibling();
		const listRows = revealer.get_first_child();
		const firstDoseRow = listRows.get_first_child();

		if (!firstDoseRow) {
			dosage.add_row(doseRow({ time: [12, 30], dose: 1 }));
		}

		globalThis.removeRow = doseRow => {
			const firstDoseRow = listRows.get_first_child();
			const lastDoseRow = listRows.get_last_child();
			
			if (firstDoseRow != lastDoseRow) dosage.remove(doseRow);
		}

		const medWindowBox = builder.get_object('medWindowBox');
		const [ medWindowBoxHeight, ] = medWindowBox.measure(Gtk.Orientation.VERTICAL, -1);
		medWindow.default_height = medWindowBoxHeight + 58;
		
		if (deleteButton.get_visible())
			medWindow.default_height -= 12;
	
		medWindow.present();

		cancelButton.connect('clicked', closeWindow);

		saveButton.connect('clicked', () => {
			const isUpdate = list && position >= 0;

			if (!isValidInput(isUpdate)) return;

			if (isUpdate) updateItem();
			else if (oneTime) addItemToHistory();
			else addItem();

			this._updateEverything();
			closeWindow();		
		});

		deleteButton.connect('clicked', () => {
			const dialog = new Adw.MessageDialog({
				heading: _("Are you sure?"),
				modal: true,
				transient_for: medWindow,
			});

			dialog.add_response('no', _("Cancel"));
			dialog.add_response('yes', _("Delete"));
			dialog.set_response_appearance('yes', Adw.ResponseAppearance.DESTRUCTIVE);
			dialog.present();

			dialog.connect('response', (_self, response) => {
				if (response === 'yes') {
					const it = this._sortedTreatmentsModel.get_item(position);
					const deletePos = treatmentsLS.find(it)[1];
					treatmentsLS.remove(deletePos);
					this._updateEverything();
					closeWindow();
				}
			});
		});

		function addItemToHistory() {
			let info = getDoses()[0];
			delete info.updated;
			historyLS.append(
				new HistoryMedication({
					name: medName.text.trim(),
					unit: medUnit.text.trim(),
					color: dosageColorButton.get_name(),
					taken: 'yes',
					info: info,
					date: new Date().toJSON(),
				})
			);
		}

		function addItem() {
			const today = new GLib.DateTime;

			let days, doses, cycle = [];
			let invOnOff, durOnOff = false;
			let name, unit, notes, color, freq, icon, 
				inventory, current, reminder, duration, start, end;

			if (medInventory.get_enable_expansion())
				invOnOff = true;

			if (medDuration.get_enable_expansion()) {
				durOnOff = true;
				start = calendarStart.get_date().format('%s');
				end = calendarEnd.get_date().format('%s');
			} else
				start = today.format('%s');

			name = medName.text.trim(),
			unit = medUnit.text.trim(),
			notes = medNotes.text.trim(),
			days = getSpecificDays();
			doses = getDoses();
			cycle[0] = cycleActive.adjustment.value;
			cycle[1] = cycleInactive.adjustment.value;
			cycle[2] = cycleCurrent.adjustment.value;
			color = dosageColorButton.get_name();
			icon = dosageIconButton.get_icon_name();
			log(icon)
			current = medCurrrentInv.value;
			reminder = medReminderInv.value;

			inventory = { enabled: invOnOff, current: current, reminder: reminder };
			duration = { enabled: durOnOff, start: start, end: end };

			if (frequencyMenu.get_selected() === 0) freq = 'daily';
			if (frequencyMenu.get_selected() === 1) freq = 'specific-days';
			if (frequencyMenu.get_selected() === 2) freq = 'cycle';
			if (frequencyMenu.get_selected() === 3) freq = 'when-needed';

			treatmentsLS.append(
				new Medication({
					name: name,
					unit: unit,
					info: {
						notes: notes,
						frequency: freq,
						color: color,
						icon: icon,
						days: days,
						cycle: cycle,
						dosage: doses,
						inventory: inventory,
						duration: duration,
					},
				})
			);
		}

		function updateItem() {
			const item = list.get_model().get_item(position);
			const today = new GLib.DateTime;
			const info = item.info;
			
			item.name = medName.text.trim();
			item.unit = medUnit.text.trim();
			info.notes = medNotes.text.trim();
			info.days = getSpecificDays();
			info.dosage = getDoses();
			info.cycle[0] = cycleActive.adjustment.value;
			info.cycle[1] = cycleInactive.adjustment.value;
			info.cycle[2] = cycleCurrent.adjustment.value;
			info.color = dosageColorButton.get_name();
			info.icon = dosageIconButton.get_icon_name();
			info.inventory.current = medCurrrentInv.value;
			info.inventory.reminder = medReminderInv.value;

			info.dosage.sort((obj1, obj2) => {
				const [ h1, m1 ] = obj1.time;
				const [ h2, m2 ] = obj2.time;
				const hm1 = `${addLeadZero(h1)}:${addLeadZero(m1)}`;
				const hm2 = `${addLeadZero(h2)}:${addLeadZero(m2)}`;
				return hm1 === hm2 ? 0 : hm1 > hm2 ? 1 : -1;
			});
			
			if (frequencyMenu.get_selected() === 0) info.frequency = 'daily';
			if (frequencyMenu.get_selected() === 1)	info.frequency = 'specific-days';
			if (frequencyMenu.get_selected() === 2) info.frequency = 'cycle';
			if (frequencyMenu.get_selected() === 3)	info.frequency = 'when-needed';

			
			if (medInventory.get_enable_expansion())
				info.inventory.enabled = true;
			else
				info.inventory.enabled = false;
			

			if (medDuration.get_enable_expansion()) {
				info.duration.enabled = true;
				info.duration.start = calendarStart.get_date().format('%s');
				info.duration.end = calendarEnd.get_date().format('%s');
			} else {	
				info.duration.start = today.format('%s');
				info.duration.enabled = false;
			}
		}

		function getDoses() {
			const doses = [];
			let currentDoseRow = listRows.get_first_child();

			while (currentDoseRow) {
				const [ hours, minutes ] = getTimeBtnInput(currentDoseRow);
				const ds = {
					time: [hours, minutes],
					dose: currentDoseRow.get_value(),
					updated: new Date().toJSON(),
				};
				doses.push(ds);
				currentDoseRow = currentDoseRow.get_next_sibling();
			}
			return(doses);
		}

		function getSpecificDays() {
			const days = [];
			const specificDaysBox = builder.get_object('specificDaysBox');

			let day = 0;
			for (const button of specificDaysBox) {
				if (button.get_active()) {
					if (!days.includes(day))
						days.push(day)
				};
				day++;
			}
			return days;
		}

		function setFreqMenuVisibility(item) {
			frequencyMenu.connect('notify::selected-item', () => {
				const selectedItemPos = frequencyMenu.get_selected();

				frequencySpecificDays.set_visible(selectedItemPos === 1);
				frequencyCycle.set_visible(selectedItemPos === 2);

				// if when-needed is selected, hide the dosage and duration rows
				if (selectedItemPos != 3) {
					dosage.set_visible(true);
					medDuration.set_visible(true);
					return;
				}

				dosage.set_visible(false);
				medDuration.set_visible(false);
			});

			if (item) {
				const freq = item.info.frequency;
				if (freq === 'daily') frequencyMenu.set_selected(0);
				if (freq === 'specific-days') frequencyMenu.set_selected(1);
				if (freq === 'cycle') frequencyMenu.set_selected(2);
				if (freq === 'when-needed') frequencyMenu.set_selected(3);
			}
		}

		function isValidInput(isUpdate) {
			const toastOverlay = builder.get_object('toastOverlay');
			medName.connect('changed', () => medName.remove_css_class('error'));
			medUnit.connect('changed', () => medUnit.remove_css_class('error'));
			
			const emptyName = medName.text.trim() == '';
			const emptyUnit = medUnit.text.trim() == '';

			if (emptyName) {
				toastOverlay.add_toast(new Adw.Toast({ title: _('Empty name') }));
				medName.add_css_class('error');
				return;
			}
			if (emptyUnit) {
				toastOverlay.add_toast(new Adw.Toast({ title: _('Empty unit') }));
				medUnit.add_css_class('error');
				return;
			}

			for (const it of treatmentsLS) {
				if (isUpdate) {
					const item = list.get_model().get_item(position);
					if (it === item) continue;
				}
				if (it.name.toLowerCase() === medName.text.trim().toLowerCase()) {
					toastOverlay.add_toast(new Adw.Toast({ title: _('Name already exists') }));
					medName.add_css_class('error');
					return;
				}
			}

			let currentDoseRow = listRows.get_first_child();
			const rows = [];

			while (currentDoseRow) {
				const [ hours, minutes, ampm, timeBtn ] = getTimeBtnInput(currentDoseRow);
				const time = String([hours, minutes])

				if (rows.includes(time)) {
					async function addError() {
						toastOverlay.add_toast(new Adw.Toast({ title: _('Duplicated time') }));
						timeBtn.add_css_class('time-error');
						ampm.add_css_class('time-error');
						await new Promise(res => setTimeout(res, 1400));
						timeBtn.remove_css_class('time-error');
						ampm.remove_css_class('time-error');
					}
					addError();
					return;
				} else
					rows.push(time);

				currentDoseRow = currentDoseRow.get_next_sibling();
			}
			return true;
		}

		function closeWindow() {
			medWindow.destroy();
		}
	}
});
