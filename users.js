const path = require('path');
const fs = require('fs');
const setup = require('./setup.js');
const bans = require('./bans.js')(setup)
const refresh = require('passport-oauth2-refresh');
const esi = require('eve-swagger');
const cache = require('./cache.js')(setup);
const db = require('./dbHandler.js').db.collection('users');
const log = require('./logger.js')(module);

module.exports = function (setup) {
	var module = {};
	//This nested if stuff is kinda unpleasant and I'd like to fix it
	module.updateUserSession = function (req, res, next) {
		if (typeof req.session.passport === "undefined" || typeof req.session.passport.user === "undefined") {
			next();
			return;
		}
		module.findAndReturnUser(req.session.passport.user.characterID, function (userData) {
			if (!userData) {
				req.logout();
				res.redirect('/');
				next();
			} else {
				req.session.passport.user = userData;
				req.session.save(function (err) {
					if (err) log.error("updateUserSession: Error for session.save", { err, 'characterID': user.characterID });
					
				})

				//check for ban
				bans.checkIfBanned(req.user.characterID, function(ban) {
					if (ban.banType == "Squad") {
						log.warn("Logging out banned user: " + req.user.name);
						req.logout();
						res.status(418).render("banned.html");
					} else {
						next();
					}
				});
			}
		});
	}

	//Create and manage users - Currently doing this via JSON and saving the object every now and then. TODO: MongoDB with mongoose maybe?
	module.findOrCreateUser = function (users, refreshToken, characterDetails, cb) {
		//Check if the user exists
		module.findAndReturnUser(characterDetails.CharacterID, function (userProfile) {
			//We found the user, return it back to the callback
			if (userProfile) {
				log.debug(`Known user ${userProfile.name} has logged in.`);
				cb(userProfile);
			} else {
				//We didn't find the user, create them as a master account
				log.info(`Creating a new user for ${characterDetails.CharacterName}.`);
				generateNewUser(refreshToken, characterDetails, null, null, function (userProfile, err) {
					cb(userProfile, err);
				});
			}
		});
	};

	module.findAndReturnUser = function (checkID, cb) {
		db.find({ 'characterID': checkID }).toArray(function (err, docs) {
			if (err) log.error("findAndReturnUser: Error for db.find.toArray", { err, checkID });
			if (docs.length === 0) {
				cb(false)
			} else {
				cb(docs[0])
			}
		});
	};

	module.getUserDataFromID = function (id, cb) {
		esi.characters(id).info().then(function (data) {
			var allianceID = data.alliance_id || 0;
			var corporationID = data.corporation_id || 0;
			esi.corporations.names(corporationID).then(function (corporation) {
				if (allianceID !== 0) {
					esi.alliances.names(allianceID).then(function (alliance) {
						cb(alliance[0], corporation[0]);
					}).catch(err => {
						log.error("users.getUserDataFromID: Error for esi.alliances.names", { err, userId: id, allianceID });
					});
				} else {
					cb(null, corporation[0])
				}
			}).catch(err => {
				log.error("users.getUserDataFromID: Error for esi.corporations.names", { err, userId: id, corporationID });
			});
		}).catch(err => {
			log.error("users.getUserDataFromID: Error for esi.characters.info", { err, id });
		});
	}

	generateNewUser = function (refreshToken, characterDetails, masterAccount, associatedMasterAccount, cb) {
		module.getUserDataFromID(characterDetails.CharacterID, function (alliance, corporation) {
			if (alliance && setup.permissions.alliances.includes(alliance.name)) {
				log.debug(`${characterDetails.CharacterName} is in alliance ${alliance.name}`)
				var newUserTemplate = {
					characterID: characterDetails.CharacterID,
					name: characterDetails.CharacterName,
					scopes: characterDetails.Scopes,
					alliance: alliance,
					corporation: corporation,
					refreshToken: refreshToken,
					role: "Member",
					roleNumeric: 0,
					registrationDate: new Date(),
					notes: "",
					ships: [],
					relatedChars: [],
					statistics: { sites: {} }
				}
				db.insert(newUserTemplate, function (err, result) {
					if (err) log.error("generateNewUser: Error for db.insert", { err, name: characterDetails.CharacterName });
					cb(newUserTemplate);
				})
			} else {
				log.warn(`${characterDetails.CharacterName} is not in a whitelisted alliance (${alliance ? alliance.name : 'null'})`)
				cb(false, `${characterDetails.CharacterName} is not in a whitelisted alliance (${alliance ? alliance.name : 'null'})`);
			}
		})
	};

	//Return a list of all users with a permission higher than 0.
	module.getFCList = function(cb) {
		db.find( { roleNumeric: {$gt: 0}}).toArray(function (err, docs) {
			if (err) log.error("fleet.getFCPageList: Error for db.find", { err });
			cb(docs);
		})
	}

	//Update a users permission and title.
	module.updateUserPermission = function(characterID, permission, adminUser, cb) {
		//Stop a user from adjusting their own access.
		if(characterID !== adminUser.characterID)
		{
			db.updateOne({ 'characterID': characterID }, { $set: { roleNumeric: Number(permission), role: setup.userPermissions[permission]} }, function (err, result) {
				if (err) log.error("Error updating user permissions ", { err, 'characterID': characterID });
				if (!err) log.debug(adminUser.Name + " changed the role of " + characterID + " to " + setup.userPermissions[permission]);
			})
		}
	}

	//Calculates the skills table for a pilot and passes it back to the controler so it can render in the view.
	module.checkSkills = function(user, skillsPackage, cb) {
		refresh.requestNewAccessToken('provider', user.refreshToken, function (err, accessToken, newRefreshToken) {
			if (err) {
				log.error("users.checkSkills: Error for requestNewAccessToken", { err, user });
				cb(err)
			} else {
				esi.characters(user.characterID, accessToken).skills().then(result => {
					//Create ESI Skills Array
					var esiSkills = [];
					for(var i = 0; i < result.skills.length; i++) {
						esiSkills[result.skills[i].skill_id] = result.skills[i];
					}
					
					//Calc General Skills
					skillsPackage.generalSkills.txtclass = "text-success";
					skillsPackage.generalSkills.txticon = `<i class="fa fa-check-circle"></i>`;
					var cSkillSet = skillsPackage.generalSkills;				
					for(var i = 0; i < cSkillSet.length; i++) {
						cSkillSet[i].actual = (esiSkills[cSkillSet[i].id])? esiSkills[cSkillSet[i].id].current_skill_level : 0;
						//did skill fail?
						if(cSkillSet[i].actual < cSkillSet[i].required && cSkillSet[i].failable == true) {
							cSkillSet[i].class = "skills-failed";
							//Set Menu Fail Indicator
							skillsPackage.generalSkills.txtclass = "text-danger";
							skillsPackage.generalSkills.txticon = `<i class="fa fa-times-circle"></i>`;
						} else {
							cSkillSet[i].class = "skills-pass";
						}
					}
					skillsPackage.generalSkills = cSkillSet;


					//skill categories
					for(var c = 0; c < skillsPackage.categories.length; c++) {
						skillsPackage.categories[c].txtclass = "text-success";
						skillsPackage.categories[c].txticon = `<i class="fa fa-check-circle"></i>`;
						var cSkillSet = skillsPackage.categories[c].Skills;			
						for(var i = 0; i < cSkillSet.length; i++) {
							cSkillSet[i].actual = (esiSkills[cSkillSet[i].id])? esiSkills[cSkillSet[i].id].current_skill_level : 0;
							//did skill fail?
							if(cSkillSet[i].actual < cSkillSet[i].required && cSkillSet[i].failable == true) {
								cSkillSet[i].class = "skills-failed";
								skillsPackage.categories[c].txtclass = "text-danger";
								skillsPackage.categories[c].txticon = `<i class="fa fa-times-circle"></i>`;
							} else {
								cSkillSet[i].class = "skills-pass";
							}
							
						}
						skillsPackage.categories[c].Skills = cSkillSet;
					}			
					//Return the skills package for the view
					skillsPackage.totalSP = result.total_sp;
					cb(skillsPackage);
				}).catch(err => {
					log.error("users.checkSkills: ", { err });
					cb(err)
				});			
			}
		})
	}

	return module;
}