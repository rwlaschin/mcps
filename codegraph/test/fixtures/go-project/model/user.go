package model

type User struct {
	Name string
}

func NewUser(name string) User {
	return User{Name: name}
}

func (user User) Greeting() string {
	return "hello " + user.Name
}
