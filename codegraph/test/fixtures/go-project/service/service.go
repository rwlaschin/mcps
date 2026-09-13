package service

import "example.com/codegraphfixture/model"

func Welcome(name string) string {
	user := model.NewUser(name)
	return user.Greeting()
}

func helper() string {
	return "hidden"
}
