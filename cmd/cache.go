package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

func Cache(cmd *cobra.Command, args []string) {
	fmt.Println("cache called")
}
